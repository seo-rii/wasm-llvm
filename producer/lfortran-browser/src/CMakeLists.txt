if(NOT EMSCRIPTEN OR NOT WITH_LLVM)
    message(FATAL_ERROR "The browser compiler requires Emscripten and the LLVM backend")
endif()

find_package(LLD REQUIRED CONFIG HINTS "${LLVM_DIR}/../lld")
# Upstream's parent-directory asr target links these names too. Promote the
# imported targets so its references resolve to the pinned archive paths.
set_target_properties(lldWasm lldCommon PROPERTIES IMPORTED_GLOBAL TRUE)
add_executable(lfortran-browser compiler.cpp)
target_link_libraries(lfortran-browser PRIVATE lfortran_lib)
set_target_properties(lfortran-browser PROPERTIES OUTPUT_NAME lfortran)

# These follow the upstream LLVM-enabled evaluator test's MAIN_MODULE settings.
# Emscripten supplies the host runtime for LLVM-generated dynamic side modules.
target_link_options(lfortran-browser PRIVATE
    -fwasm-exceptions
    "SHELL:-s MAIN_MODULE=1"
    "SHELL:-s MODULARIZE=1"
    "SHELL:-s EXPORT_NAME=createLFortran"
    "SHELL:-s EXPORT_ES6=1"
    "SHELL:-s ENVIRONMENT=web,worker,node"
    "SHELL:-s ALLOW_MEMORY_GROWTH=1"
    "SHELL:-s STACK_SIZE=32mb"
    "SHELL:-s INITIAL_MEMORY=128mb"
    "SHELL:-s FORCE_FILESYSTEM=1"
    "SHELL:-s INVOKE_RUN=0"
    "SHELL:-s EXPORTED_RUNTIME_METHODS=FS,callMain"
)
file(GLOB RUNTIME_MOD_FILES "${LFORTRAN_BROWSER_MOD_DIR}/*.mod")
if(NOT RUNTIME_MOD_FILES)
    message(FATAL_ERROR "Native LFortran must generate runtime .mod files first")
endif()
foreach(MOD_FILE IN LISTS RUNTIME_MOD_FILES)
    get_filename_component(MOD_NAME "${MOD_FILE}" NAME)
    target_link_options(lfortran-browser PRIVATE
        "SHELL:--preload-file \"${MOD_FILE}@/lib/${MOD_NAME}\"")
endforeach()
set_property(TARGET lfortran-browser APPEND PROPERTY LINK_DEPENDS ${RUNTIME_MOD_FILES})
