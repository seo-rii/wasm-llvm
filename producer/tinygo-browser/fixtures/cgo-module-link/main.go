package main

/*
#include <stdlib.h>

// Stable LLVM C API declarations, implemented by the actual native LLVM shared
// library. No replacement linker, IR parser or module implementation is used.
typedef struct LLVMOpaqueContext *LLVMContextRef;
typedef struct LLVMOpaqueModule *LLVMModuleRef;
typedef struct LLVMOpaqueMemoryBuffer *LLVMMemoryBufferRef;
typedef struct LLVMOpaqueValue *LLVMValueRef;
extern LLVMContextRef LLVMContextCreate(void);
extern void LLVMContextDispose(LLVMContextRef);
extern LLVMModuleRef LLVMModuleCreateWithNameInContext(const char *, LLVMContextRef);
extern void LLVMDisposeModule(LLVMModuleRef);
extern const char *LLVMGetTarget(LLVMModuleRef);
extern void LLVMSetTarget(LLVMModuleRef, const char *);
extern const char *LLVMGetDataLayoutStr(LLVMModuleRef);
extern void LLVMSetDataLayout(LLVMModuleRef, const char *);
extern int LLVMCreateMemoryBufferWithContentsOfFile(const char *, LLVMMemoryBufferRef *, char **);
extern int LLVMParseBitcodeInContext2(LLVMContextRef, LLVMMemoryBufferRef, LLVMModuleRef *);
extern void LLVMDisposeMemoryBuffer(LLVMMemoryBufferRef);
extern void LLVMDisposeMessage(char *);
extern int LLVMLinkModules2(LLVMModuleRef, LLVMModuleRef);
extern int LLVMVerifyModule(LLVMModuleRef, int, char **);
extern LLVMValueRef LLVMGetNamedGlobal(LLVMModuleRef, const char *);
extern LLVMValueRef LLVMGetNamedFunction(LLVMModuleRef, const char *);
extern LLVMValueRef LLVMGetInitializer(LLVMValueRef);
extern unsigned long long LLVMConstIntGetZExtValue(LLVMValueRef);
extern void LLVMGetVersion(unsigned *, unsigned *, unsigned *);
*/
import "C"

import (
	"encoding/json"
	"fmt"
	"os"
	"unsafe"
)

type nativeModule struct{ ref C.LLVMModuleRef }

func (m nativeModule) Target() string { return C.GoString(C.LLVMGetTarget(m.ref)) }
func (m nativeModule) DataLayout() string {
	return C.GoString(C.LLVMGetDataLayoutStr(m.ref))
}
func (m nativeModule) SetTarget(value string) {
	text := C.CString(value)
	defer C.free(unsafe.Pointer(text))
	C.LLVMSetTarget(m.ref, text)
}
func (m nativeModule) setLayout(value string) {
	text := C.CString(value)
	defer C.free(unsafe.Pointer(text))
	C.LLVMSetDataLayout(m.ref, text)
}

type linkCase struct {
	name, destination, input, layout string
	invalidLayout, reject            bool
}

func runCase(item linkCase, inputPath, expectedLayout string, normalize bool) (map[string]any, error) {
	context := C.LLVMContextCreate()
	defer C.LLVMContextDispose(context)
	name := C.CString("tinygo-package")
	destination := nativeModule{C.LLVMModuleCreateWithNameInContext(name, context)}
	C.free(unsafe.Pointer(name))
	defer C.LLVMDisposeModule(destination.ref)
	destination.SetTarget(item.destination)
	destination.setLayout(expectedLayout)
	if item.name == "empty-destination-layout" {
		destination.setLayout("")
	}
	filename := C.CString(inputPath)
	defer C.free(unsafe.Pointer(filename))
	var buffer C.LLVMMemoryBufferRef
	var message *C.char
	if C.LLVMCreateMemoryBufferWithContentsOfFile(filename, &buffer, &message) != 0 {
		text := C.GoString(message)
		C.LLVMDisposeMessage(message)
		return nil, fmt.Errorf("read bitcode: %s", text)
	}
	defer C.LLVMDisposeMemoryBuffer(buffer)
	var ref C.LLVMModuleRef
	if C.LLVMParseBitcodeInContext2(context, buffer, &ref) != 0 {
		return nil, fmt.Errorf("native LLVM rejected Clang bitcode")
	}
	header := nativeModule{ref}
	defer func() {
		if header.ref != nil {
			C.LLVMDisposeModule(header.ref)
		}
	}()
	if header.Target() != "wasm32-unknown-wasip1" || header.DataLayout() != expectedLayout {
		return nil, fmt.Errorf("Clang input ABI differs: %q %q", header.Target(), header.DataLayout())
	}
	header.SetTarget(item.input)
	if item.invalidLayout {
		header.setLayout(item.layout)
	}
	beforeTarget, beforeLayout := header.Target(), header.DataLayout()
	result := map[string]any{"case": item.name, "inputTarget": beforeTarget}
	if normalize {
		err := normalizeCGoHeaderTarget(destination, header)
		if item.reject {
			if err == nil || header.Target() != beforeTarget || header.DataLayout() != beforeLayout {
				return nil, fmt.Errorf("invalid ABI was accepted or mutated: %s", item.name)
			}
			result["result"], result["reason"] = "rejected-before-link", err.Error()
			return result, nil
		}
		if err != nil {
			return nil, err
		}
		if header.Target() != destination.Target() || header.DataLayout() != beforeLayout {
			return nil, fmt.Errorf("normalization changed more than the exact target alias")
		}
	}
	result["linkedTarget"] = header.Target()
	linked := C.LLVMLinkModules2(destination.ref, header.ref)
	header.ref = nil // LLVM consumes the source module on both success and failure.
	if linked != 0 {
		return nil, fmt.Errorf("native LLVM module linking failed")
	}
	if C.LLVMVerifyModule(destination.ref, 2, &message) != 0 {
		text := C.GoString(message)
		C.LLVMDisposeMessage(message)
		return nil, fmt.Errorf("native LLVM module verification failed: %s", text)
	}
	if message != nil {
		C.LLVMDisposeMessage(message)
	}
	marker := C.CString("tinygo_module_link_marker")
	defer C.free(unsafe.Pointer(marker))
	global := C.LLVMGetNamedGlobal(destination.ref, marker)
	if global == nil || C.LLVMConstIntGetZExtValue(C.LLVMGetInitializer(global)) != 42 {
		return nil, fmt.Errorf("linked C global initializer was not preserved")
	}
	functionName := C.CString("tinygo_module_link_add")
	defer C.free(unsafe.Pointer(functionName))
	if C.LLVMGetNamedFunction(destination.ref, functionName) == nil {
		return nil, fmt.Errorf("linked C function was not preserved")
	}
	result["result"], result["globalValue"] = "linked-and-verified", 42
	return result, nil
}

func run() error {
	if len(os.Args) != 4 {
		return fmt.Errorf("expected mode, Clang bitcode and exact DataLayout")
	}
	var major, minor, patch C.unsigned
	C.LLVMGetVersion(&major, &minor, &patch)
	if major != 22 {
		return fmt.Errorf("native preflight needs LLVM 22, got %d", major)
	}
	old, canonical := "wasm32-unknown-wasi", "wasm32-unknown-wasip1"
	cases := []linkCase{{name: "legacy-destination", destination: old, input: canonical}}
	normalize := os.Args[1] == "normalize"
	if normalize {
		cases = append(cases,
			linkCase{name: "canonical-destination", destination: canonical, input: old},
			linkCase{name: "same-legacy", destination: old, input: old},
			linkCase{name: "same-canonical", destination: canonical, input: canonical},
			linkCase{name: "preview2", destination: old, input: "wasm32-unknown-wasip2", reject: true},
			linkCase{name: "wasm64", destination: old, input: "wasm64-unknown-wasip1", reject: true},
			linkCase{name: "unknown-vendor", destination: old, input: "wasm32-vendor-wasip1", reject: true},
			linkCase{name: "different-layout", destination: old, input: canonical, invalidLayout: true, layout: "e-m:e-p:64:64-i64:64-n32:64-S128", reject: true},
			linkCase{name: "empty-header-layout", destination: old, input: canonical, invalidLayout: true, layout: "", reject: true},
			linkCase{name: "empty-destination-layout", destination: old, input: canonical, reject: true},
		)
	} else if os.Args[1] != "baseline" {
		return fmt.Errorf("invalid mode")
	}
	var results []map[string]any
	for _, item := range cases {
		result, err := runCase(item, os.Args[2], os.Args[3], normalize)
		if err != nil {
			return fmt.Errorf("%s: %w", item.name, err)
		}
		results = append(results, result)
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{
		"mode": os.Args[1], "llvmVersion": fmt.Sprintf("%d.%d.%d", major, minor, patch), "cases": results,
	})
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
