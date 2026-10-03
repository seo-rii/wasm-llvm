// A command entry point for the upstream compiler evaluator. The JavaScript
// filesystem, Worker, input transport, cancellation and UI belong to consumers.
#include <fstream>
#include <iostream>
#include <iterator>
#include <string>

#include <lfortran/fortran_evaluator.h>
#include <libasr/pass/pass_manager.h>

int main(int argc, char **argv) {
    if (argc != 2) {
        std::cerr << "usage: lfortran-browser /path/to/program.f90\n";
        return 2;
    }
    std::ifstream input(argv[1]);
    if (!input) {
        std::cerr << "cannot read source: " << argv[1] << '\n';
        return 2;
    }
    const std::string source((std::istreambuf_iterator<char>(input)), {});
    try {
        LCompilers::CompilerOptions options;
        options.target = "wasm32-unknown-emscripten";
        // Upstream evaluate executes program units through its interactive
        // entry point; the batch path emits an ordinary main without calling it.
        options.interactive = true;
        options.po.runtime_library_dir = "/lib";
        options.use_colors = false;
        LCompilers::FortranEvaluator evaluator(options);
        LCompilers::LocationManager locations;
        LCompilers::LocationManager::FileLocations file;
        file.in_filename = argv[1];
        locations.files.push_back(file);
        LCompilers::PassManager passes;
        passes.use_default_passes();
        LCompilers::diag::Diagnostics diagnostics;
        auto result = evaluator.evaluate(source, false, locations, passes, diagnostics);
        const std::string messages = diagnostics.render(locations, options);
        if (!messages.empty()) std::cerr << messages;
        std::cout.flush();
        std::cerr.flush();
        return result.ok ? 0 : 1;
    } catch (const std::exception &error) {
        std::cerr << "LFortran: " << error.what() << '\n';
        return 1;
    }
}
