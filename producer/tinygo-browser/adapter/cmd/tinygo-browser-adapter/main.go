// Command tinygo-browser-adapter compiles one explicit Go package graph with
// upstream TinyGo. It intentionally stops at an object file: raw WASI LLD and
// Binaryen run outside this compiler process.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/tinygo-org/tinygo/builder"
	"github.com/tinygo-org/tinygo/compileopts"
	"github.com/tinygo-org/tinygo/compiler"
	llvm "tinygo.org/x/go-llvm"
)

const (
	packageJSONEnvironment     = "TINYGO_BROWSER_PACKAGE_JSON"
	compilerBuildIDEnvironment = "TINYGO_BROWSER_COMPILER_BUILD_ID"
	linkPlanFormat             = "wasm-llvm-tinygo-link-plan-v5"
	llvmValidationToolchain    = "llvm-20.1.1"
	wasmTargetTriple           = "wasm32-unknown-wasi"
	wasmTargetDataLayout       = "e-m:e-p:32:32-p10:8:8-p20:8:8-i64:64-i128:128-n32:64-S128-ni:1:10:20"
)

// Keep the upstream cgo package in this graph: it is backed by libclang and
// must be cross-compiled with the compiler instead of replaced by a WASI stub.
var upstreamCompilerPackages = []string{
	"github.com/tinygo-org/tinygo/builder",
	"github.com/tinygo-org/tinygo/cgo",
	"github.com/tinygo-org/tinygo/compiler",
	"github.com/tinygo-org/tinygo/interp",
	"github.com/tinygo-org/tinygo/loader",
	"github.com/tinygo-org/tinygo/transform",
	"tinygo.org/x/go-llvm",
}

type request struct {
	Package            string           `json:"package"`
	PackageJSON        string           `json:"packageJSON"`
	WorkingDirectory   string           `json:"workingDirectory"`
	OutputDirectory    string           `json:"outputDirectory"`
	TemporaryDirectory string           `json:"temporaryDirectory"`
	Target             string           `json:"target"`
	Opt                string           `json:"opt"`
	GC                 string           `json:"gc"`
	PanicStrategy      string           `json:"panicStrategy"`
	Scheduler          string           `json:"scheduler"`
	Debug              bool             `json:"debug"`
	Parallelism        int              `json:"parallelism"`
	Runtime            runtimeArtifacts `json:"runtime"`
}

type runtimeArtifacts struct {
	CompilerRT string            `json:"compilerRT"`
	WasiLibc   string            `json:"wasiLibc"`
	LibCxx     string            `json:"libCxx"`
	LibCxxAbi  string            `json:"libCxxAbi"`
	ExtraFiles map[string]string `json:"extraFiles"`
}

type packageJSON struct {
	ImportPath string
	Dir        string
	Goroot     bool
	CgoFiles   []string
	CFiles     []string
	CXXFiles   []string
	SFiles     []string
	EmbedFiles []string
}

type linkPlan struct {
	SchemaVersion    int                `json:"schemaVersion"`
	Format           string             `json:"format"`
	CompilerSHA256   string             `json:"compilerSha256"`
	Capabilities     []string           `json:"capabilities"`
	CompilerPackages []string           `json:"compilerPackages"`
	Linker           string             `json:"linker"`
	Objects          []linkPlanObject   `json:"objects"`
	Output           string             `json:"output"`
	Arguments        []string           `json:"arguments"`
	RuntimeInputs    []runtimeInput     `json:"runtimeInputs"`
	CGoInputs        []linkPlanCGoInput `json:"cgoInputs"`
	Optimizer        optimizerLinkPlan  `json:"optimizer"`
}

type linkPlanCGoInput struct {
	ImportPath   string               `json:"importPath"`
	SourcePath   string               `json:"sourcePath"`
	Bytes        int                  `json:"bytes"`
	SHA256       string               `json:"sha256"`
	Dependencies []linkPlanDependency `json:"dependencies"`
}

type linkPlanDependency struct {
	Scope  string `json:"scope"`
	Path   string `json:"path"`
	Bytes  int    `json:"bytes"`
	SHA256 string `json:"sha256"`
}

type linkPlanObject struct {
	Kind             string                `json:"kind"`
	Path             string                `json:"path"`
	Format           string                `json:"format"`
	Bytes            int                   `json:"bytes"`
	SHA256           string                `json:"sha256"`
	ImportPath       string                `json:"importPath,omitempty"`
	SourceField      string                `json:"sourceField,omitempty"`
	SourcePath       string                `json:"sourcePath,omitempty"`
	SourceSHA256     string                `json:"sourceSha256,omitempty"`
	EmbeddedFileHash string                `json:"embeddedFileHash,omitempty"`
	Dependencies     []linkPlanDependency  `json:"dependencies,omitempty"`
	LLVMValidation   *llvmObjectValidation `json:"llvmValidation,omitempty"`
	WasmValidation   *wasmObjectValidation `json:"wasmValidation,omitempty"`
}

type llvmObjectValidation struct {
	Toolchain           string   `json:"toolchain"`
	ModuleVerified      bool     `json:"moduleVerified"`
	TargetTriple        string   `json:"targetTriple"`
	DataLayout          string   `json:"dataLayout"`
	ThreadLocalGlobals  int      `json:"threadLocalGlobals"`
	GlobalConstructors  int      `json:"globalConstructors"`
	GlobalDestructors   int      `json:"globalDestructors"`
	ForbiddenABISymbols []string `json:"forbiddenAbiSymbols"`
}

type wasmObjectValidation struct {
	Profile        string `json:"profile"`
	LinkingVersion int    `json:"linkingVersion"`
	SymbolTable    bool   `json:"symbolTable"`
}

type runtimeInput struct {
	Kind   string `json:"kind"`
	Source string `json:"source,omitempty"`
	Path   string `json:"path"`
}

type optimizerLinkPlan struct {
	Tool      string   `json:"tool"`
	Input     string   `json:"input"`
	Output    string   `json:"output"`
	Arguments []string `json:"arguments"`
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "tinygo-browser-adapter:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) != 1 {
		return errors.New("usage: tinygo-browser-adapter REQUEST.json")
	}

	request, err := readRequest(args[0])
	if err != nil {
		return err
	}
	if err := request.prepare(); err != nil {
		return err
	}
	packages, err := validatePackageJSON(request.PackageJSON)
	if err != nil {
		return err
	}
	compilerSHA256 := os.Getenv(compilerBuildIDEnvironment)
	decodedCompilerSHA256, err := hex.DecodeString(compilerSHA256)
	if err != nil || len(decodedCompilerSHA256) != sha256.Size {
		return fmt.Errorf("%s must identify the compiler build", compilerBuildIDEnvironment)
	}
	if err := os.Setenv(packageJSONEnvironment, request.PackageJSON); err != nil {
		return fmt.Errorf("set %s: %w", packageJSONEnvironment, err)
	}

	options := &compileopts.Options{
		GOOS:          "wasip1",
		GOARCH:        "wasm",
		Directory:     request.WorkingDirectory,
		Target:        request.Target,
		Opt:           request.Opt,
		GC:            request.GC,
		PanicStrategy: request.PanicStrategy,
		Scheduler:     request.Scheduler,
		SkipDWARF:     !request.Debug,
		Debug:         request.Debug,
		InterpTimeout: 3 * time.Minute,
		Semaphore:     make(chan struct{}, request.Parallelism),
	}
	if err := options.Verify(); err != nil {
		return err
	}
	config, err := builder.NewConfig(options)
	if err != nil {
		return fmt.Errorf("create TinyGo config: %w", err)
	}
	expectedDataLayout, err := deriveExpectedDataLayout(config)
	if err != nil {
		return err
	}

	if err := os.MkdirAll(request.OutputDirectory, 0o777); err != nil {
		return fmt.Errorf("create output directory: %w", err)
	}
	objectsDirectory := filepath.Join(request.OutputDirectory, "objects")
	if err := os.MkdirAll(objectsDirectory, 0o777); err != nil {
		return fmt.Errorf("create objects directory: %w", err)
	}
	if err := os.MkdirAll(request.TemporaryDirectory, 0o777); err != nil {
		return fmt.Errorf("create temporary directory: %w", err)
	}

	temporaryObject := filepath.Join(request.TemporaryDirectory, "tinygo-browser-program.o")
	defer os.Remove(temporaryObject)
	buildResult, err := builder.Build(request.Package, temporaryObject, request.TemporaryDirectory, config)
	if err != nil {
		return fmt.Errorf("upstream TinyGo object compilation failed: %w", err)
	}
	cgoInputs, err := collectCGoInputs(packages, buildResult.CGoInputs, request.WorkingDirectory)
	if err != nil {
		return err
	}
	expectedNativeObjects := map[string]struct{}{}
	for _, pkg := range packages {
		for _, source := range []struct {
			field string
			files []string
		}{
			{"CFiles", pkg.CFiles},
			{"CXXFiles", pkg.CXXFiles},
		} {
			for _, sourcePath := range source.files {
				expectedNativeObjects[nativeSourceIdentity(pkg.ImportPath, source.field, sourcePath)] = struct{}{}
			}
		}
		if !pkg.Goroot {
			for _, sourcePath := range pkg.SFiles {
				expectedNativeObjects[nativeSourceIdentity(pkg.ImportPath, "SFiles", sourcePath)] = struct{}{}
			}
		}
	}

	objects := make([]linkPlanObject, 0, 1+len(buildResult.AuxiliaryObjects))
	const programObjectName = "objects/0000-program.o"
	programObject := filepath.Join(request.OutputDirectory, filepath.FromSlash(programObjectName))
	if err := replaceFile(temporaryObject, programObject); err != nil {
		return fmt.Errorf("publish program object: %w", err)
	}
	programBytes, err := os.ReadFile(programObject)
	if err != nil {
		return fmt.Errorf("read published program object: %w", err)
	}
	programSHA256 := sha256.Sum256(programBytes)
	objects = append(objects, linkPlanObject{
		Kind:   "program",
		Path:   programObjectName,
		Format: "wasm-object",
		Bytes:  len(programBytes),
		SHA256: hex.EncodeToString(programSHA256[:]),
	})

	sort.SliceStable(buildResult.AuxiliaryObjects, func(left, right int) bool {
		leftObject := buildResult.AuxiliaryObjects[left]
		rightObject := buildResult.AuxiliaryObjects[right]
		if leftObject.Kind != rightObject.Kind {
			return auxiliaryKindOrder(leftObject.Kind) < auxiliaryKindOrder(rightObject.Kind)
		}
		if leftObject.ImportPath != rightObject.ImportPath {
			return leftObject.ImportPath < rightObject.ImportPath
		}
		return leftObject.SourcePath < rightObject.SourcePath
	})
	for index, object := range buildResult.AuxiliaryObjects {
		defer os.Remove(object.Path)
		if (object.Kind != "embed" && object.Kind != "target-c" && object.Kind != "target-cxx" && object.Kind != "target-assembly") || object.ImportPath == "" || object.SourcePath == "" {
			return errors.New("upstream TinyGo returned an invalid auxiliary object identity")
		}
		cleanSourcePath := filepath.ToSlash(filepath.Clean(object.SourcePath))
		if filepath.IsAbs(object.SourcePath) || strings.Contains(object.SourcePath, "\\") ||
			cleanSourcePath != object.SourcePath || cleanSourcePath == "." ||
			cleanSourcePath == ".." || strings.HasPrefix(cleanSourcePath, "../") {
			return fmt.Errorf("upstream TinyGo returned unsafe auxiliary source path %q", object.SourcePath)
		}
		pkg, ok := packages[object.ImportPath]
		if !ok {
			return fmt.Errorf("upstream TinyGo returned an object for unknown package %q", object.ImportPath)
		}
		var objectName string
		var objectFormat string
		var dependencies []linkPlanDependency
		if object.Kind == "embed" {
			sourceDigest, sourceDigestError := hex.DecodeString(object.SourceSHA256)
			if sourceDigestError != nil || len(sourceDigest) != sha256.Size ||
				object.EmbeddedFileHash != object.SourceSHA256[:sha256.Size] {
				return fmt.Errorf("upstream TinyGo returned invalid embed source evidence for %q", object.SourcePath)
			}
			objectName = fmt.Sprintf("objects/%04d-embed.o", index+1)
			objectFormat = "wasm-object"
		} else {
			var sourceFiles []string
			var expectedField string
			var suffix string
			switch object.Kind {
			case "target-c":
				sourceFiles = pkg.CFiles
				expectedField = "CFiles"
				suffix = "target-c.bc"
				objectFormat = "llvm-bitcode"
			case "target-cxx":
				sourceFiles = pkg.CXXFiles
				expectedField = "CXXFiles"
				suffix = "target-cxx.bc"
				objectFormat = "llvm-bitcode"
			case "target-assembly":
				sourceFiles = pkg.SFiles
				expectedField = "SFiles"
				suffix = "target-assembly.o"
				objectFormat = "wasm-object"
			}
			if object.SourceField != expectedField || !containsString(sourceFiles, object.SourcePath) {
				return fmt.Errorf("upstream TinyGo returned an unbound %s object for %q", object.Kind, object.SourcePath)
			}
			identity := nativeSourceIdentity(object.ImportPath, object.SourceField, object.SourcePath)
			if _, ok := expectedNativeObjects[identity]; !ok {
				return fmt.Errorf("upstream TinyGo returned duplicate target-native object %q", object.SourcePath)
			}
			delete(expectedNativeObjects, identity)
			_, sourceSHA256, sourceError := inspectSourceFile(pkg, object.SourcePath)
			if sourceError != nil {
				return sourceError
			}
			object.SourceSHA256 = sourceSHA256
			dependencies, err = collectDependencies(object.Dependencies, request.WorkingDirectory)
			if err != nil {
				return fmt.Errorf("collect target-native dependencies for %q: %w", object.SourcePath, err)
			}
			objectName = fmt.Sprintf("objects/%04d-%s", index+1, suffix)
		}
		publishedObject := filepath.Join(request.OutputDirectory, filepath.FromSlash(objectName))
		if err := replaceFile(object.Path, publishedObject); err != nil {
			return fmt.Errorf("publish auxiliary object %q: %w", object.SourcePath, err)
		}
		objectBytes, err := os.ReadFile(publishedObject)
		if err != nil {
			return fmt.Errorf("read published auxiliary object %q: %w", object.SourcePath, err)
		}
		var llvmValidation *llvmObjectValidation
		var wasmValidation *wasmObjectValidation
		if object.Kind == "target-c" || object.Kind == "target-cxx" {
			validation, validationError := validateLLVMObject(publishedObject, expectedDataLayout)
			if validationError != nil {
				return fmt.Errorf("validate %s output for %q: %w", object.Kind, object.SourcePath, validationError)
			}
			llvmValidation = &validation
		}
		if object.Kind == "target-assembly" {
			if !hasWasmRelocatableFraming(objectBytes) {
				return fmt.Errorf("validate WebAssembly assembly output for %q: invalid relocatable object framing", object.SourcePath)
			}
			if validationError := builder.ValidateWasmObject(publishedObject); validationError != nil {
				return fmt.Errorf("validate WebAssembly assembly output for %q with LLVMObject: %w", object.SourcePath, validationError)
			}
			wasmValidation = &wasmObjectValidation{
				Profile:        "wasm-relocatable-object-v1",
				LinkingVersion: 2,
				SymbolTable:    true,
			}
		}
		objectSHA256 := sha256.Sum256(objectBytes)
		objects = append(objects, linkPlanObject{
			Kind:             object.Kind,
			Path:             objectName,
			Format:           objectFormat,
			Bytes:            len(objectBytes),
			SHA256:           hex.EncodeToString(objectSHA256[:]),
			ImportPath:       object.ImportPath,
			SourceField:      object.SourceField,
			SourcePath:       object.SourcePath,
			SourceSHA256:     object.SourceSHA256,
			EmbeddedFileHash: object.EmbeddedFileHash,
			Dependencies:     dependencies,
			LLVMValidation:   llvmValidation,
			WasmValidation:   wasmValidation,
		})
	}
	if len(expectedNativeObjects) != 0 {
		return errors.New("upstream TinyGo omitted one or more target-native objects")
	}

	plan, err := createLinkPlan(config, request.Runtime, compilerSHA256, objects, cgoInputs)
	if err != nil {
		return err
	}
	if err := writeJSONFile(filepath.Join(request.OutputDirectory, "link-plan.json"), plan); err != nil {
		return fmt.Errorf("write link plan: %w", err)
	}

	return nil
}

func readRequest(path string) (request, error) {
	file, err := os.Open(path)
	if err != nil {
		return request{}, fmt.Errorf("open request: %w", err)
	}
	defer file.Close()

	var value request
	decoder := json.NewDecoder(file)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		return request{}, fmt.Errorf("decode request: %w", err)
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return request{}, err
	}
	return value, nil
}

func ensureJSONEOF(decoder *json.Decoder) error {
	var extra any
	err := decoder.Decode(&extra)
	if errors.Is(err, io.EOF) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("decode trailing request data: %w", err)
	}
	return errors.New("request contains more than one JSON value")
}

func (request *request) prepare() error {
	if request.Package == "" {
		request.Package = "."
	}
	if request.Target == "" {
		request.Target = "wasip1"
	}
	if request.Target != "wasip1" {
		return fmt.Errorf("target must be wasip1, got %q", request.Target)
	}
	if request.Opt == "" {
		request.Opt = "1"
	}
	if request.Opt != "1" {
		return fmt.Errorf("compile protocol v5 requires opt=1, got %q", request.Opt)
	}
	if request.GC == "" {
		request.GC = "precise"
	}
	if request.GC != "precise" {
		return fmt.Errorf("compile protocol v5 requires gc=precise, got %q", request.GC)
	}
	if request.PanicStrategy == "" {
		request.PanicStrategy = "print"
	}
	if request.PanicStrategy != "print" {
		return fmt.Errorf(
			"compile protocol v5 requires panicStrategy=print, got %q",
			request.PanicStrategy,
		)
	}
	if request.Scheduler == "" {
		request.Scheduler = "asyncify"
	}
	if request.Scheduler != "asyncify" {
		return fmt.Errorf(
			"compile protocol v5 requires scheduler=asyncify, got %q",
			request.Scheduler,
		)
	}
	if request.Debug {
		return errors.New("compile protocol v5 does not provide a debug runtime closure")
	}
	if request.Parallelism == 0 {
		request.Parallelism = 1
	}
	if request.Parallelism != 1 {
		return errors.New("compile protocol v5 requires parallelism=1")
	}

	requiredPaths := []struct {
		name  string
		value *string
	}{
		{"packageJSON", &request.PackageJSON},
		{"workingDirectory", &request.WorkingDirectory},
		{"outputDirectory", &request.OutputDirectory},
		{"temporaryDirectory", &request.TemporaryDirectory},
		{"runtime.compilerRT", &request.Runtime.CompilerRT},
		{"runtime.wasiLibc", &request.Runtime.WasiLibc},
		{"runtime.libCxx", &request.Runtime.LibCxx},
		{"runtime.libCxxAbi", &request.Runtime.LibCxxAbi},
	}
	for _, required := range requiredPaths {
		if *required.value == "" {
			return fmt.Errorf("%s is required", required.name)
		}
		absolute, err := filepath.Abs(*required.value)
		if err != nil {
			return fmt.Errorf("resolve %s: %w", required.name, err)
		}
		*required.value = absolute
	}
	if request.Runtime.ExtraFiles == nil {
		return errors.New("runtime.extraFiles is required")
	}
	for source, artifact := range request.Runtime.ExtraFiles {
		if source == "" || artifact == "" {
			return errors.New("runtime.extraFiles keys and values must be non-empty")
		}
		absolute, err := filepath.Abs(artifact)
		if err != nil {
			return fmt.Errorf("resolve runtime.extraFiles[%q]: %w", source, err)
		}
		request.Runtime.ExtraFiles[source] = absolute
	}
	return nil
}

func validatePackageJSON(path string) (map[string]packageJSON, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open packageJSON: %w", err)
	}
	defer file.Close()
	goRoot := os.Getenv("GOROOT")
	if goRoot == "" {
		return nil, errors.New("GOROOT is required")
	}
	goRoot, err = filepath.Abs(goRoot)
	if err != nil {
		return nil, fmt.Errorf("resolve GOROOT: %w", err)
	}

	decoder := json.NewDecoder(file)
	packages := map[string]packageJSON{}
	for {
		var pkg packageJSON
		err := decoder.Decode(&pkg)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("decode packageJSON: %w", err)
		}
		if pkg.ImportPath == "" || pkg.Dir == "" {
			return nil, errors.New("packageJSON contains a package without identity")
		}
		if _, exists := packages[pkg.ImportPath]; exists {
			return nil, fmt.Errorf("packageJSON contains duplicate package %q", pkg.ImportPath)
		}
		for _, files := range [][]string{pkg.CgoFiles, pkg.CFiles, pkg.CXXFiles, pkg.SFiles} {
			for _, sourcePath := range files {
				if !isSafeRelativePath(sourcePath) {
					return nil, fmt.Errorf("package %q contains unsafe native source path %q", pkg.ImportPath, sourcePath)
				}
			}
		}
		if len(pkg.SFiles) != 0 {
			packageDirectory, pathErr := filepath.Abs(pkg.Dir)
			relative, relativeErr := filepath.Rel(goRoot, packageDirectory)
			isRootPackage := pathErr == nil && relativeErr == nil && pkg.Goroot && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative)
			if !isRootPackage {
				if len(pkg.CgoFiles) == 0 {
					return nil, fmt.Errorf(
						"package %q uses workspace assembly without CGo; compile protocol v4 keeps Go/Plan9 assembly fail-closed",
						pkg.ImportPath,
					)
				}
				for _, sourcePath := range pkg.SFiles {
					if filepath.Ext(sourcePath) != ".S" {
						return nil, fmt.Errorf(
							"package %q uses %q; compile protocol v4 accepts only Clang WebAssembly .S files from the workspace",
							pkg.ImportPath,
							sourcePath,
						)
					}
				}
			}
		}
		if pkg.Goroot {
			packageDirectory, pathErr := filepath.Abs(pkg.Dir)
			relative, relativeErr := filepath.Rel(goRoot, packageDirectory)
			if pathErr != nil || relativeErr != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
				return nil, fmt.Errorf("package %q claims Goroot outside GOROOT", pkg.ImportPath)
			}
		}
		packages[pkg.ImportPath] = pkg
	}
	if len(packages) == 0 {
		return nil, errors.New("packageJSON contains no packages")
	}
	return packages, nil
}

func collectCGoInputs(packages map[string]packageJSON, buildInputs []builder.BuildCGoInput, workspaceRoot string) ([]linkPlanCGoInput, error) {
	dependenciesByPackage := make(map[string][]string, len(buildInputs))
	for _, input := range buildInputs {
		if input.ImportPath == "" {
			return nil, errors.New("upstream TinyGo returned CGo input without an import path")
		}
		if _, exists := dependenciesByPackage[input.ImportPath]; exists {
			return nil, fmt.Errorf("upstream TinyGo returned duplicate CGo input %q", input.ImportPath)
		}
		dependenciesByPackage[input.ImportPath] = append([]string(nil), input.Dependencies...)
	}

	importPaths := make([]string, 0, len(packages))
	for importPath, pkg := range packages {
		if len(pkg.CgoFiles) != 0 {
			importPaths = append(importPaths, importPath)
		}
	}
	sort.Strings(importPaths)
	inputs := make([]linkPlanCGoInput, 0)
	for _, importPath := range importPaths {
		pkg := packages[importPath]
		dependencyPaths, ok := dependenciesByPackage[importPath]
		if !ok {
			return nil, fmt.Errorf("upstream TinyGo omitted CGo input evidence for %q", importPath)
		}
		dependencies, err := collectDependencies(dependencyPaths, workspaceRoot)
		if err != nil {
			return nil, fmt.Errorf("collect CGo dependencies for %q: %w", importPath, err)
		}
		sourcePaths := append([]string(nil), pkg.CgoFiles...)
		sort.Strings(sourcePaths)
		for _, sourcePath := range sourcePaths {
			bytes, sourceSHA256, err := inspectSourceFile(pkg, sourcePath)
			if err != nil {
				return nil, err
			}
			inputs = append(inputs, linkPlanCGoInput{
				ImportPath: importPath,
				SourcePath: sourcePath,
				Bytes:      bytes,
				SHA256:     sourceSHA256,
				Dependencies: append(
					make([]linkPlanDependency, 0, len(dependencies)),
					dependencies...,
				),
			})
		}
		delete(dependenciesByPackage, importPath)
	}
	if len(dependenciesByPackage) != 0 {
		return nil, errors.New("upstream TinyGo returned unexpected CGo input evidence")
	}
	return inputs, nil
}

func collectDependencies(paths []string, workspaceRoot string) ([]linkPlanDependency, error) {
	root := os.Getenv("TINYGOROOT")
	if root == "" {
		return nil, errors.New("TINYGOROOT is required")
	}
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("resolve TINYGOROOT: %w", err)
	}
	workspaceRoot, err = filepath.Abs(workspaceRoot)
	if err != nil {
		return nil, fmt.Errorf("resolve workspace root: %w", err)
	}

	dependencies := make([]linkPlanDependency, 0, len(paths))
	seen := map[string]struct{}{}
	for _, dependencyPath := range paths {
		// libclang reports each unsaved CGo translation unit using TinyGo's
		// synthetic "!cgo.c" suffix. It has no filesystem identity and is
		// already bound by the CGo source hash, so it is not a link-plan
		// dependency.
		if strings.HasSuffix(filepath.ToSlash(dependencyPath), "!cgo.c") {
			continue
		}
		absolute, err := filepath.Abs(dependencyPath)
		if err != nil {
			return nil, fmt.Errorf("resolve dependency %q: %w", dependencyPath, err)
		}
		scope, relative, ok := relativeToRoot(absolute, workspaceRoot, "workspace")
		if !ok {
			scope, relative, ok = relativeToRoot(absolute, root, "root")
		}
		if !ok || !isSafeRelativePath(relative) {
			return nil, fmt.Errorf("dependency %q is outside the workspace and TinyGo root", dependencyPath)
		}
		identity := scope + ":" + relative
		if _, exists := seen[identity]; exists {
			continue
		}
		seen[identity] = struct{}{}
		data, err := os.ReadFile(absolute)
		if err != nil {
			return nil, fmt.Errorf("read dependency %q: %w", dependencyPath, err)
		}
		digest := sha256.Sum256(data)
		dependencies = append(dependencies, linkPlanDependency{
			Scope:  scope,
			Path:   relative,
			Bytes:  len(data),
			SHA256: hex.EncodeToString(digest[:]),
		})
	}
	sort.Slice(dependencies, func(left, right int) bool {
		if dependencies[left].Scope != dependencies[right].Scope {
			return dependencies[left].Scope < dependencies[right].Scope
		}
		return dependencies[left].Path < dependencies[right].Path
	})
	return dependencies, nil
}

func relativeToRoot(path, root, scope string) (string, string, bool) {
	relative, err := filepath.Rel(root, path)
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return "", "", false
	}
	return scope, filepath.ToSlash(relative), true
}

func inspectSourceFile(pkg packageJSON, sourcePath string) (int, string, error) {
	if !isSafeRelativePath(sourcePath) {
		return 0, "", fmt.Errorf("package %q has unsafe source path %q", pkg.ImportPath, sourcePath)
	}
	absolute := filepath.Join(pkg.Dir, filepath.FromSlash(sourcePath))
	if _, _, ok := relativeToRoot(absolute, pkg.Dir, "package"); !ok {
		return 0, "", fmt.Errorf("package %q source escapes its directory", pkg.ImportPath)
	}
	data, err := os.ReadFile(absolute)
	if err != nil {
		return 0, "", fmt.Errorf("read package %q source %q: %w", pkg.ImportPath, sourcePath, err)
	}
	digest := sha256.Sum256(data)
	return len(data), hex.EncodeToString(digest[:]), nil
}

func isSafeRelativePath(path string) bool {
	clean := filepath.ToSlash(filepath.Clean(path))
	return path != "" && !filepath.IsAbs(path) && !strings.Contains(path, "\\") && clean == path && clean != "." && clean != ".." && !strings.HasPrefix(clean, "../")
}

func containsString(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func nativeSourceIdentity(importPath, sourceField, sourcePath string) string {
	return importPath + "\x00" + sourceField + "\x00" + sourcePath
}

func auxiliaryKindOrder(kind string) int {
	switch kind {
	case "target-c":
		return 0
	case "target-cxx":
		return 1
	case "target-assembly":
		return 2
	case "embed":
		return 3
	default:
		return 4
	}
}

func deriveExpectedDataLayout(config *compileopts.Config) (string, error) {
	if config.Triple() != wasmTargetTriple {
		return "", fmt.Errorf("compile protocol v5 requires LLVM triple %q", wasmTargetTriple)
	}
	machine, err := compiler.NewTargetMachine(&compiler.Config{
		Triple:          config.Triple(),
		CPU:             config.CPU(),
		Features:        config.Features(),
		CodeModel:       config.CodeModel(),
		RelocationModel: config.RelocationModel(),
	})
	if err != nil {
		return "", fmt.Errorf("create protocol target machine: %w", err)
	}
	defer machine.Dispose()
	targetData := machine.CreateTargetData()
	defer targetData.Dispose()
	dataLayout := targetData.String()
	if dataLayout != wasmTargetDataLayout {
		return "", fmt.Errorf("compile protocol v5 requires LLVM data layout %q, got %q", wasmTargetDataLayout, dataLayout)
	}
	return dataLayout, nil
}

func validateLLVMObject(path, expectedDataLayout string) (llvmObjectValidation, error) {
	validation := llvmObjectValidation{
		Toolchain:           llvmValidationToolchain,
		TargetTriple:        wasmTargetTriple,
		DataLayout:          expectedDataLayout,
		ForbiddenABISymbols: []string{},
	}
	context := llvm.NewContext()
	defer context.Dispose()
	module, err := context.ParseBitcodeFile(path)
	if err != nil {
		return validation, errors.New("LLVM 20 bitreader rejected the module")
	}
	defer module.Dispose()
	if err := llvm.VerifyModule(module, llvm.ReturnStatusAction); err != nil {
		return validation, fmt.Errorf("LLVM verifier rejected the module: %w", err)
	}
	if module.Target() != wasmTargetTriple {
		return validation, fmt.Errorf("LLVM module target must be %q, got %q", wasmTargetTriple, module.Target())
	}
	if module.DataLayout() != expectedDataLayout {
		return validation, fmt.Errorf("LLVM module data layout must be %q, got %q", expectedDataLayout, module.DataLayout())
	}

	forbiddenSymbols := map[string]struct{}{}
	for global := module.FirstGlobal(); !global.IsNil(); global = llvm.NextGlobal(global) {
		name := global.Name()
		section := global.Section()
		if global.IsThreadLocal() || strings.HasPrefix(section, ".tdata") || strings.HasPrefix(section, ".tbss") {
			validation.ThreadLocalGlobals++
		}
		if name == "llvm.global_ctors" || strings.HasPrefix(section, ".preinit_array") || strings.HasPrefix(section, ".init_array") || strings.HasPrefix(section, ".ctors") {
			validation.GlobalConstructors++
		}
		if name == "llvm.global_dtors" || strings.HasPrefix(section, ".fini_array") || strings.HasPrefix(section, ".dtors") {
			validation.GlobalDestructors++
		}
		if strings.HasPrefix(name, "_ZZ") || isForbiddenNativeABISymbol(name) {
			forbiddenSymbols[name] = struct{}{}
		}
	}
	for function := module.FirstFunction(); !function.IsNil(); function = llvm.NextFunction(function) {
		if isForbiddenNativeABISymbol(function.Name()) {
			forbiddenSymbols[function.Name()] = struct{}{}
		}
	}
	for symbol := range forbiddenSymbols {
		validation.ForbiddenABISymbols = append(validation.ForbiddenABISymbols, symbol)
	}
	sort.Strings(validation.ForbiddenABISymbols)
	if err := validateLLVMTargetFeatures(module.String()); err != nil {
		return validation, err
	}
	if validation.ThreadLocalGlobals != 0 || validation.GlobalConstructors != 0 ||
		validation.GlobalDestructors != 0 || len(validation.ForbiddenABISymbols) != 0 {
		return validation, fmt.Errorf(
			"native module violates the freestanding ABI policy (tls=%d, ctors=%d, dtors=%d, forbidden=%v)",
			validation.ThreadLocalGlobals,
			validation.GlobalConstructors,
			validation.GlobalDestructors,
			validation.ForbiddenABISymbols,
		)
	}
	validation.ModuleVerified = true
	return validation, nil
}

func isForbiddenNativeABISymbol(name string) bool {
	if name == "atexit" || name == "__dso_handle" || name == "__gxx_personality_v0" ||
		name == "__clang_call_terminate" || name == "__tls_get_addr" ||
		name == "__wasm_call_ctors" || name == "__wasm_apply_data_relocs" {
		return true
	}
	for _, prefix := range []string{
		"__cxa_",
		"__cxx_global_var_init",
		"__emutls_",
		"__tls_",
		"_GLOBAL__",
		"_Unwind_",
		"_ZGV",
		"_ZTI",
		"_ZTS",
		"_ZTV",
		"_ZNSt",
		"_ZNKSt",
		"_ZSt",
		"_Zd",
		"_Zn",
		"llvm.eh.",
		"llvm.threadlocal.",
	} {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

func validateLLVMTargetFeatures(moduleIR string) error {
	for _, line := range strings.Split(moduleIR, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "module asm ") {
			return errors.New("LLVM module-level inline assembly is forbidden; use an uppercase .S input")
		}
		if strings.HasPrefix(trimmed, "@") &&
			(strings.Contains(trimmed, " alias ") || strings.Contains(trimmed, " ifunc ")) {
			return errors.New("LLVM global aliases and indirect functions are forbidden")
		}
		if strings.Contains(trimmed, " asm ") &&
			(strings.HasPrefix(trimmed, "call ") || strings.Contains(trimmed, " call ") ||
				strings.HasPrefix(trimmed, "invoke ") || strings.Contains(trimmed, " invoke ") ||
				strings.HasPrefix(trimmed, "callbr ") || strings.Contains(trimmed, " callbr ")) {
			return errors.New("LLVM function-level inline assembly is forbidden; use an uppercase .S input")
		}
	}

	const marker = `"target-features"="`
	for offset := 0; ; {
		start := strings.Index(moduleIR[offset:], marker)
		if start < 0 {
			return nil
		}
		start += offset + len(marker)
		end := strings.IndexByte(moduleIR[start:], '"')
		if end < 0 {
			return errors.New("LLVM module contains malformed target-features evidence")
		}
		features := strings.Split(moduleIR[start:start+end], ",")
		for _, feature := range features {
			switch feature {
			case "+bulk-memory", "+bulk-memory-opt", "+call-indirect-overlong", "+mutable-globals", "+nontrapping-fptoint", "+sign-ext", "-multivalue", "-reference-types":
				// This is the exact feature policy supplied to the consumer's
				// wasm32 LLD invocations.
			default:
				return fmt.Errorf("LLVM module target feature %q is outside the strict allowlist", feature)
			}
		}
		offset = start + end + 1
	}
}

// hasWasmRelocatableFraming bounds every section and the metadata records that
// have historically caused LLVM's Wasm parser to terminate on malformed LEBs.
// LLVMObject performs the complete semantic object/symbol/relocation parse.
func hasWasmRelocatableFraming(data []byte) bool {
	if len(data) < 8 || string(data[:4]) != "\x00asm" || data[4] != 1 || data[5] != 0 || data[6] != 0 || data[7] != 0 {
		return false
	}
	foundLinking := false
	foundSymbolTable := false
	sectionCount := 0
	for offset := 8; offset < len(data); {
		sectionID := data[offset]
		offset++
		if sectionID > 13 {
			return false
		}
		sectionSize, next, ok := readULEB32(data, offset)
		if !ok || sectionSize == 0 || sectionSize > uint32(len(data)-next) {
			return false
		}
		sectionEnd := next + int(sectionSize)
		if sectionID == 0 {
			nameSize, nameOffset, nameOK := readULEB32(data, next)
			if !nameOK || nameSize > uint32(sectionEnd-nameOffset) {
				return false
			}
			nameEnd := nameOffset + int(nameSize)
			name := string(data[nameOffset:nameEnd])
			switch {
			case name == "linking":
				if foundLinking {
					return false
				}
				foundLinking = true
				version, payloadOffset, versionOK := readULEB32(data, nameEnd)
				if !versionOK || version != 2 {
					return false
				}
				for payloadOffset < sectionEnd {
					if payloadOffset >= len(data) {
						return false
					}
					subsectionType := data[payloadOffset]
					payloadOffset++
					subsectionSize, subsectionOffset, subsectionOK := readULEB32(data, payloadOffset)
					if !subsectionOK || subsectionSize > uint32(sectionEnd-subsectionOffset) {
						return false
					}
					if subsectionType == 8 {
						if foundSymbolTable {
							return false
						}
						foundSymbolTable = true
					}
					payloadOffset = subsectionOffset + int(subsectionSize)
				}
				if payloadOffset != sectionEnd {
					return false
				}
			case strings.HasPrefix(name, "reloc."):
				if !hasWasmRelocationFraming(data, nameEnd, sectionEnd, sectionCount) {
					return false
				}
			}
		}
		offset = sectionEnd
		sectionCount++
	}
	return foundLinking && foundSymbolTable
}

func hasWasmRelocationFraming(data []byte, offset, end, sectionCount int) bool {
	targetSection, offset, ok := readULEB32(data, offset)
	if !ok || targetSection >= uint32(sectionCount) {
		return false
	}
	count, offset, ok := readULEB32(data, offset)
	if !ok || count > uint32(end-offset) {
		return false
	}
	for index := uint32(0); index < count; index++ {
		relocationType, next, typeOK := readULEB32(data, offset)
		if !typeOK || relocationType > 26 ||
			(relocationType >= 14 && relocationType <= 19) ||
			relocationType == 21 || relocationType == 22 || relocationType == 24 || relocationType == 25 {
			return false
		}
		offset = next
		_, offset, ok = readULEB32(data, offset)
		if !ok {
			return false
		}
		_, offset, ok = readULEB32(data, offset)
		if !ok {
			return false
		}
		if wasmRelocationHasAddend(relocationType) {
			_, offset, ok = readSLEB128(data, offset)
			if !ok {
				return false
			}
		}
	}
	return offset == end
}

func wasmRelocationHasAddend(relocationType uint32) bool {
	switch relocationType {
	case 3, 4, 5, 8, 9, 11, 14, 15, 16, 17, 21, 22, 23, 25:
		return true
	default:
		return false
	}
}

func readULEB32(data []byte, offset int) (uint32, int, bool) {
	var value uint32
	for index := uint(0); index < 5 && offset < len(data); index++ {
		current := data[offset]
		offset++
		if index == 4 && current&0xf0 != 0 {
			return 0, offset, false
		}
		value |= uint32(current&0x7f) << (index * 7)
		if current&0x80 == 0 {
			return value, offset, true
		}
	}
	return 0, offset, false
}

func readSLEB128(data []byte, offset int) (int64, int, bool) {
	var value int64
	var current byte
	for shift := uint(0); shift < 64 && offset < len(data); shift += 7 {
		current = data[offset]
		offset++
		value |= int64(current&0x7f) << shift
		if current&0x80 == 0 {
			if shift < 63 && current&0x40 != 0 {
				value |= ^int64(0) << (shift + 7)
			}
			return value, offset, true
		}
	}
	return 0, offset, false
}

func createLinkPlan(config *compileopts.Config, runtime runtimeArtifacts, compilerSHA256 string, objects []linkPlanObject, cgoInputs []linkPlanCGoInput) (linkPlan, error) {
	const (
		linkerOutput    = "program.unoptimized.wasm"
		optimizerOutput = "program.wasm"
	)

	arguments := append([]string{}, config.LDFlags()...)
	arguments = append(arguments, "-o", linkerOutput)
	if !config.Debug() {
		arguments = append(arguments, "--strip-debug", "--compress-relocations")
	}
	if len(objects) == 0 || objects[0].Kind != "program" {
		return linkPlan{}, errors.New("link plan requires one leading program object")
	}
	arguments = append(arguments, objects[0].Path)
	arguments = append(arguments, runtime.CompilerRT)

	runtimeInputs := []runtimeInput{
		{Kind: "compiler-rt", Path: runtime.CompilerRT},
	}
	for _, source := range config.ExtraFiles() {
		artifact, ok := runtime.ExtraFiles[source]
		if !ok {
			return linkPlan{}, fmt.Errorf("runtime.extraFiles is missing %q", source)
		}
		arguments = append(arguments, artifact)
		runtimeInputs = append(runtimeInputs, runtimeInput{
			Kind:   "extra-file",
			Source: source,
			Path:   artifact,
		})
	}
	for _, object := range objects[1:] {
		if object.Kind == "target-c" || object.Kind == "target-cxx" || object.Kind == "target-assembly" {
			arguments = append(arguments, object.Path)
		}
	}
	hasHostedCXX := false
	for _, object := range objects[1:] {
		if object.Kind == "target-cxx" {
			hasHostedCXX = true
			break
		}
	}
	if hasHostedCXX {
		arguments = append(arguments, runtime.LibCxx, runtime.LibCxxAbi)
		runtimeInputs = append(runtimeInputs,
			runtimeInput{Kind: "libcxx", Path: runtime.LibCxx},
			runtimeInput{Kind: "libcxxabi", Path: runtime.LibCxxAbi},
		)
	}
	arguments = append(arguments, runtime.WasiLibc)
	runtimeInputs = append(runtimeInputs, runtimeInput{Kind: "wasi-libc", Path: runtime.WasiLibc})
	for _, object := range objects[1:] {
		if object.Kind == "embed" {
			arguments = append(arguments, object.Path)
		}
	}

	_, speedLevel, sizeLevel := config.OptLevel()
	arguments = append(
		arguments,
		"-mllvm",
		"-mcpu="+config.CPU(),
		"-mllvm",
		"-mattr="+config.Features(),
		fmt.Sprintf("--lto-O%d", speedLevel),
	)
	if sizeLevel >= 2 {
		arguments = append(arguments, "-mllvm", "--rotation-max-header-size=0")
	}

	optLevel, _, _ := config.OptLevel()
	optimizerArguments := make([]string, 0, 6)
	if config.Scheduler() == "asyncify" {
		optimizerArguments = append(optimizerArguments, "--asyncify")
	}
	optimizerArguments = append(
		optimizerArguments,
		"-"+optLevel,
		"-g",
		linkerOutput,
		"--output",
		optimizerOutput,
	)

	return linkPlan{
		SchemaVersion:    5,
		Format:           linkPlanFormat,
		CompilerSHA256:   compilerSHA256,
		Capabilities:     []string{"go-embed-objects", "target-cgo-c", "target-cxx-hosted-noeh", "target-clang-assembly"},
		CompilerPackages: append([]string(nil), upstreamCompilerPackages...),
		Linker:           "wasm-ld",
		Objects:          append([]linkPlanObject(nil), objects...),
		Output:           linkerOutput,
		Arguments:        arguments,
		RuntimeInputs:    runtimeInputs,
		CGoInputs:        append([]linkPlanCGoInput(nil), cgoInputs...),
		Optimizer: optimizerLinkPlan{
			Tool:      "wasm-opt",
			Input:     linkerOutput,
			Output:    optimizerOutput,
			Arguments: optimizerArguments,
		},
	}, nil
}

func replaceFile(source, destination string) error {
	if err := os.Remove(destination); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return os.Rename(source, destination)
}

func writeJSONFile(path string, value any) error {
	temporary := path + ".tmp"
	file, err := os.Create(temporary)
	if err != nil {
		return err
	}
	encoder := json.NewEncoder(file)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(value); err != nil {
		file.Close()
		os.Remove(temporary)
		return err
	}
	if err := file.Close(); err != nil {
		os.Remove(temporary)
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		os.Remove(temporary)
		return err
	}
	return os.Rename(temporary, path)
}
