import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir,writeFile,readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { readRegular,sha256,verifyFile,writeJson } from '../../scripts/source.mjs';
import { normalizeImports } from '../klib-signature-index/transform.mjs';
import { balancedSpan } from '../fir-navigation/transform.mjs';
import { actualSelection,HERE,REPO,BUILD } from './fixture.mjs';
import { applyChanges,FAMILY } from './transform.mjs';
const execute=promisify(execFile),identity=bytes=>({bytes:bytes.length,sha256:sha256(bytes)});
const relocate=text=>text.replaceAll(/\bcom\.intellij\.(?!platform\.syntax\b)/g,'org.jetbrains.kotlin.com.intellij.');
export async function runSyntaxRuntime(outputRoot){
    outputRoot=path.resolve(outputRoot);await mkdir(outputRoot,{mode:0o700});const bootstrap=await verifyBootstrap();
    const flagsBytes=await readRegular(path.join(HERE,'../build-flags.json')),flags=JSON.parse(flagsBytes);
    const lockBytes=await readRegular(path.join(HERE,'sources.lock.json')),lock=JSON.parse(lockBytes),current=await actualSelection();
    const stdlib=bootstrap.artifacts.find(r=>r.id==='stdlib-jvm').path,commands=[],inputs=[],artifacts=[],projections=[];
    async function pinned(filename,pin=null){const bytes=await readRegular(filename);if(pin)verifyFile(bytes,pin);inputs.push({filename,...identity(bytes)});return bytes;}
    async function put(relative,bytes){const filename=path.join(outputRoot,relative);await mkdir(path.dirname(filename),{recursive:true,mode:0o700});await writeFile(filename,bytes,{flag:'wx',mode:0o600});artifacts.push({path:relative,...identity(bytes)});return filename;}
    async function run(phase,command,args){const start=performance.now();try{const result=await execute(command,args,{cwd:outputRoot,timeout:300000,maxBuffer:8*1024*1024});commands.push({phase,argv:[command,...args],exitCode:0,elapsedMs:performance.now()-start});if(result.stderr)process.stderr.write(result.stderr);return result.stdout;}catch(error){await writeJson(path.join(outputRoot,'failure.json'),{phase,exitCode:error.code,commands,stderr:String(error.stderr??'').slice(-12000)});if(error.stderr)process.stderr.write(String(error.stderr).slice(-12000));throw new Error(phase+' failed');}}
    const jvm=['-Xmx768m','-cp',bootstrap.classPath,'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-jvm-target','17','-language-version',flags.languageVersion,'-api-version',flags.apiVersion,...flags.compilerFlags];
    const originals=new Map(),originalFull=[];
    for(const pin of lock.sources){const bytes=await pinned(path.join(REPO,'out/kotlin-compiler-port/sources',pin.path),pin);originals.set(pin.path,bytes);originalFull.push(await put('original-full/'+pin.path,Buffer.from(relocate(bytes.toString()))));}
    // The registration roster names an unrelated checker newer than the
    // bootstrap artifact. Typecheck the complete eighteen-file syntax family;
    // roster preservation is instead covered by its exact reversible byte proof.
    await run('complete-eighteen-original-family-sources-jvm-typecheck','java',[...jvm,'-classpath',bootstrap.classPath,'-Xfriend-paths='+bootstrap.classPath.split(path.delimiter).join(','),'-d',path.join(outputRoot,'original-full.jar'),...originalFull.filter(file=>FAMILY.some(logical=>file.endsWith('/'+logical)))]);
    const positionRecipe=JSON.parse(await pinned(path.join(HERE,'../positioning/positioning.recipe.json'))),javaSources=[];
    for(const pin of positionRecipe.originals.filter(r=>r.path.endsWith('.java'))){const root=pin.sourceRoot==='compiler-closure'?path.join(REPO,'out/kotlin-compiler-port/sources'):path.join(REPO,'out/kotlin-positioning-sources');javaSources.push(await put('original-java/'+pin.path,Buffer.from(relocate((await pinned(path.join(root,pin.path),pin)).toString()))));}
    const classes=path.join(outputRoot,'original-classes');await mkdir(classes);await run('genuine-legacy-node-token-javac','javac',['-classpath',bootstrap.classPath,'-d',classes,...javaSources]);
    const originalClassPath=classes+path.delimiter+bootstrap.classPath;
    const helpersPath='compiler/frontend.common-psi/src/org/jetbrains/kotlin/diagnostics/LightTreePositioningStrategies.kt';
    const helperOriginal=(await pinned(path.join(REPO,'out/kotlin-positioning-sources',helpersPath),positionRecipe.originals.find(r=>r.path===helpersPath))).toString();
    const helper=balancedSpan(helperOriginal,'fun FlyweightCapableTreeStructure<LighterASTNode>.getChildrenArray(').text;
    const observed={};
    for(const variant of ['original','common']){
        const portable=variant==='common',sources=[];
        const imports=portable?'import org.jetbrains.kotlin.portable.source.*':[
            'import org.jetbrains.kotlin.com.intellij.lang.LighterASTNode','import org.jetbrains.kotlin.com.intellij.openapi.util.Ref','import org.jetbrains.kotlin.com.intellij.psi.tree.IElementType',
            'import org.jetbrains.kotlin.com.intellij.psi.tree.TokenSet','import org.jetbrains.kotlin.com.intellij.util.diff.FlyweightCapableTreeStructure'].join('\n');
        let template=(await pinned(path.join(HERE,'SyntaxProbe.kt.in'))).toString();
        template=template.replace('@IMPORTS@',imports).replace('@NODE_MEMBERS@',portable?'override val tokenType:IElementType get()=type\n    override val startOffset:Int get()=start\n    override val endOffset:Int get()=end':'override fun getTokenType():IElementType=type\n    override fun getStartOffset():Int=start\n    override fun getEndOffset():Int=end').replaceAll('@SUFFIX@',portable?'':'?');
        sources.push(await put(variant+'/SyntaxProbe.kt',Buffer.from(template)));
        const bindings={FirExpressionSyntaxChecker:'ExpressionBoundary',FirWhenExpression:'WhenPayload',FirStatement:'StatementPayload',KtLightSourceElement:'SourcePayload',KtSourceElement:'SourcePayload',AbstractKtSourceElement:'SourcePayload',KtRealSourceElementKind:'SourceKindPayload.Real',CheckerContext:'ContextPayload',DiagnosticContext:'ContextPayload',DiagnosticReporter:'ReporterPayload',FirErrors:'DiagnosticIds'};
        let code='package org.jetbrains.kotlin.portable.syntaxprobe\n'+imports+'\nimport org.jetbrains.kotlin.KtNodeTypes\nimport org.jetbrains.kotlin.ElementTypeUtils.getOperationSymbol\nimport org.jetbrains.kotlin.ElementTypeUtils.isExpression\nimport org.jetbrains.kotlin.util.getChildren\n';
        const tokenNames=lock.objectOwners['org.jetbrains.kotlin.lexer.KtTokens'],nodeNames=lock.objectOwners['org.jetbrains.kotlin.KtNodeTypes'];
        code+=tokenNames.map(n=>'import org.jetbrains.kotlin.lexer.KtTokens.'+n).join('\n')+'\n'+nodeNames.map(n=>'import org.jetbrains.kotlin.KtNodeTypes.'+n).join('\n')+'\n';
        for(const name of ['FirConfusingWhenBranchSyntaxChecker','FirAnnotatedBinaryExpressionChecker']){
            const logical=FAMILY.find(p=>p.endsWith('/'+name+'.kt')),original=originals.get(logical),shipping=applyChanges(original,lock.changes[logical]);
            let declaration=balancedSpan(shipping.toString(),'object '+name+' :').text;
            const methods=[...original.toString().matchAll(/    override fun checkLightTree\(/g)].map(m=>balancedSpan(original.toString(),'    override fun checkLightTree(').text);
            for(const method of methods)assert(shipping.toString().includes(method),'Original light-tree method body changed');
            for(const [from,to] of Object.entries(bindings))declaration=declaration.replaceAll(new RegExp('\\b'+from+'\\b','g'),to);
            projections.push({variant,path:logical,originalSha256:sha256(original),shippingSha256:sha256(shipping),fullObjectSha256:sha256(Buffer.from(declaration)),preservedOriginalLightTreeMethods:methods.map(m=>identity(Buffer.from(m))),bindings});code+=declaration+'\n';
        }
        code+=(portable?helper.replace('getChildren(node, childrenRef)','getChildren(node, childrenRef.asChildrenRef())'):helper)+'\n';
        sources.push(await put(variant+'/ExactSyntaxAlgorithms.kt',Buffer.from(code)));
        const supportNames=['KtTokens.kt','KtNodeTypes.kt','KtStubBasedElementTypes.kt','LegacyTokens.kt','LegacyNodeType.kt','KDocTokens.kt','LightTreeUtils.kt','ElementTypeUtils.kt'];
        if(portable){
            for(const name of supportNames){const row=current.retainedSources.find(r=>r.path==='compiler-port-positioning/'+name);assert(row);const bytes=normalizeImports(await pinned(row.filename),lock.recordedPropertyImports);let body=bytes.toString();if(name==='ElementTypeUtils.kt')body=body.replace(/^(package[^\n]+\n)/m,'$1import org.jetbrains.kotlin.portable.assertions.compilerAssert as assert\n');sources.push(await put(variant+'/'+name,Buffer.from(body)));}
            for(const [logical,name] of [['compiler-port-host/PortableLightTree.kt','PortableLightTree.kt'],['compiler-port-positioning/TokenSet.kt','TokenSet.kt'],['compiler-port-assertions/CompilerAssertions.kt','CompilerAssertions.kt']]){const row=current.retainedSources.find(r=>r.path===logical);assert(row);sources.push(await put(variant+'/'+name,normalizeImports(await pinned(row.filename),lock.recordedPropertyImports)));}
        }else{
            const treePath='compiler/frontend.common/src/org/jetbrains/kotlin/util/LightTreeUtils.kt';
            sources.push(await put(variant+'/LightTreeUtils.kt',Buffer.from(relocate((await pinned(path.join(REPO,'out/kotlin-compiler-port/sources',treePath),positionRecipe.originals.find(r=>r.path===treePath))).toString()))));
            const elementPath='compiler/psi/psi-impl/src/org/jetbrains/kotlin/ElementTypeUtils.kt';sources.push(await put(variant+'/ElementTypeUtils.kt',Buffer.from(relocate((await pinned(path.join(REPO,'out/kotlin-positioning-sources',elementPath),positionRecipe.originals.find(r=>r.path===elementPath))).toString()))));
        }
        const jar=path.join(outputRoot,variant+'.jar');const jvmEntry=path.join(HERE,'JvmEntry.kt');await pinned(jvmEntry);
        await run(variant+'-exact-algorithms-jvm-compile','java',[...jvm,'-classpath',portable?stdlib:originalClassPath,...(portable?['-Xmulti-platform','-Xcommon-sources='+sources.join(',')]:[]),'-d',jar,...sources,jvmEntry]);
        observed[variant]=await run(variant+'-exact-algorithms-jvm-observe','java',['-ea','-cp',jar+path.delimiter+(portable?stdlib:originalClassPath),'org.jetbrains.kotlin.portable.syntaxprobe.JvmEntryKt']);
        await put(variant+'-observations.txt',Buffer.from(observed[variant]));
        if(portable){
            assert.equal(observed.common,observed.original);await mkdir(path.join(outputRoot,'klib'));await mkdir(path.join(outputRoot,'wasm'));
            const wasm=['-Xmx768m','-cp',bootstrap.classPath,'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler','-Xwasm-target=wasm-js','-language-version',flags.languageVersion,'-api-version',flags.apiVersion,'-libraries',bootstrap.wasmJsStdlib,...flags.compilerFlags];
            const wasmEntry=path.join(HERE,'WasmEntry.kt');await pinned(wasmEntry);
            await run('common-exact-algorithms-wasm-klib','java',[...wasm,'-Xmulti-platform','-Xcommon-sources='+sources.join(','),'-Xir-produce-klib-file','-ir-output-dir',path.join(outputRoot,'klib'),'-ir-output-name','syntax',...sources,wasmEntry]);
            await run('common-exact-algorithms-wasm-binary','java',[...wasm,'-Xir-produce-js','-Xinclude='+path.join(outputRoot,'klib/syntax.klib'),'-ir-output-dir',path.join(outputRoot,'wasm'),'-ir-output-name','syntax','-main','noCall','-Xwasm-enable-array-range-checks','-Xwasm-enable-asserts']);
            observed.wasm=await run('actual-node-wasm-observe',process.execPath,['--experimental-wasm-exnref','--input-type=module','-e','const m=await import(process.argv[1]);process.stdout.write(m.firSyntaxSnapshot());',pathToFileURL(path.join(outputRoot,'wasm/syntax.mjs')).href]);
            assert.equal(observed.wasm,observed.original);await put('wasm-observations.txt',Buffer.from(observed.wasm));
        }
    }
    for(const relative of ['original-full.jar','original.jar','common.jar','klib/syntax.klib',...(await readdir(path.join(outputRoot,'wasm'))).map(n=>'wasm/'+n)])artifacts.push({path:relative,...identity(await readRegular(path.join(outputRoot,relative)))});
    const result={schemaVersion:1,kind:'fir-syntax-exact-lighttree-algorithm-differential',result:'pass',source:lock.source,sourceLockSha256:sha256(lockBytes),
        tool:identity(await readRegular(fileURLToPath(import.meta.url))),inputs,artifacts,commands,projections,
        comparison:{records:observed.original.trimEnd().split('\n').length,originalJvmSha256:sha256(Buffer.from(observed.original)),commonJvmSha256:sha256(Buffer.from(observed.common)),wasmSha256:sha256(Buffer.from(observed.wasm)),rawOutputNormalization:false},
        completeOriginalSourcesJvmTypechecked:18,registrationRosterJvmTypechecked:false,fullFirRuntime:false,fullFirSourceHostRuntime:false,diagnosticFactoryRuntime:false,
        explicitProofBoundary:'Full retained two checker objects, with declared source/FIR/type/context/report callback payload bindings; genuine legacy token/tree algorithms and carriers.',
        remainingSixteenReplacementAlgorithms:'Exact reversible source proof, not executed by this observer',fullCompilerBuilt:false,kmpLiteralAffixDiagnosticParity:false};
    await writeJson(path.join(outputRoot,'differential.json'),result);console.log(JSON.stringify({outputRoot,result:result.result,comparison:result.comparison}));return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await runSyntaxRuntime(process.argv[2]);
