#if !defined(__STDC_ISO_10646__) || __STDC_ISO_10646__ < 201706L
#error "glibc ISO 10646 date must be visible before the first include"
#endif
#if !defined(__STDC_IEC_559__) || __STDC_IEC_559__ != 1
#error "glibc IEC 559 semantics must be visible before the first include"
#endif

int glibc_predefs(void) { return 1; }
