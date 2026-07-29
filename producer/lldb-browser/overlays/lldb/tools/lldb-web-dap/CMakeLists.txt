add_lldb_tool(lldb-web-dap
  lldb-web-dap.cpp
  SharedRingIO.cpp

  LINK_COMPONENTS
    WebAssembly
  LINK_LIBS
    lldbDAP
)

target_compile_options(lldb-web-dap PRIVATE -pthread)

target_link_options(lldb-web-dap PRIVATE
  -pthread
  "SHELL:--js-library ${CMAKE_CURRENT_SOURCE_DIR}/library_lldb_shared_ring.js"
  "SHELL:-sPTHREAD_POOL_SIZE=8"
  "SHELL:-sPROXY_TO_PTHREAD=1"
  "SHELL:-sMODULARIZE=1"
  "SHELL:-sEXPORT_ES6=1"
  "SHELL:-sEXPORT_NAME=createLldbWebDapModule"
  "SHELL:-sENVIRONMENT=worker"
  "SHELL:-sINVOKE_RUN=0"
  "SHELL:-sINCOMING_MODULE_JS_API=['locateFile','mainScriptUrlOrBlob','noInitialRun','onAbort','onExit','stdout','stderr','print','printErr']"
  "SHELL:-sEXPORTED_RUNTIME_METHODS=['FS','callMain','HEAPU8']"
  "SHELL:-sFILESYSTEM=1"
  "SHELL:-sALLOW_MEMORY_GROWTH=1"
  "SHELL:-sINITIAL_MEMORY=536870912"
  "SHELL:-sMAXIMUM_MEMORY=4294967296"
  "SHELL:-sSTACK_SIZE=8388608"
  "SHELL:-sWASM_BIGINT=1"
  # Emscripten 6 has no public import-minification toggle. Assertions keep
  # the shared-ring import names stable for the browser transport contract.
  "SHELL:-sASSERTIONS=1"
  "SHELL:-sEXIT_RUNTIME=1"
  "SHELL:-sERROR_ON_UNDEFINED_SYMBOLS=1"
  -Wl,--gc-sections
)

set(lldb_web_dap_pthread_worker
  ${LLVM_RUNTIME_OUTPUT_INTDIR}/lldb-web-dap.pthread.mjs
)
add_custom_command(OUTPUT ${lldb_web_dap_pthread_worker}
  COMMAND ${CMAKE_COMMAND} -E make_directory
    ${LLVM_RUNTIME_OUTPUT_INTDIR}
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
    ${CMAKE_CURRENT_SOURCE_DIR}/lldb-web-dap.pthread.mjs
    ${lldb_web_dap_pthread_worker}
  DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/lldb-web-dap.pthread.mjs
  VERBATIM
)
add_custom_target(lldb-web-dap-pthread-worker
  DEPENDS ${lldb_web_dap_pthread_worker}
)
add_dependencies(lldb-web-dap lldb-web-dap-pthread-worker)
