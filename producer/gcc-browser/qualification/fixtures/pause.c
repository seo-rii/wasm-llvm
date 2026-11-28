void spin_hint(void) {
    __builtin_ia32_pause();
}

void memory_fences(void) {
    __builtin_ia32_lfence();
    __builtin_ia32_sfence();
    __builtin_ia32_mfence();
}
