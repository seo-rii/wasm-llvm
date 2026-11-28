#include <stdio.h>
#include <unwind.h>

static _Unwind_Reason_Code count_frame(struct _Unwind_Context *ctx, void *data) {
    if (_Unwind_GetIP(ctx)) ++*(int *)data;
    return _URC_NO_REASON;
}

int main(void) {
    int frames = 0;
    _Unwind_Backtrace(count_frame, &frames);
    if (!frames) return 1;
    puts("ok");
}
