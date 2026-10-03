/*
 * Copyright (C) 2026 wasm-idle contributors.
 * SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception
 */

#include "wasm_debug_transport.h"

#include "wasm_export.h"

struct wasm_debug_transport {
    bool closed;
};

extern int
wasm_idle_rsp_read(uint8_t *buffer, uint32_t length, int32_t timeout_ms);

extern int
wasm_idle_rsp_write(const uint8_t *buffer, uint32_t length,
                    int32_t timeout_ms);

extern void
wasm_idle_rsp_close(void);

extern void
wasm_idle_rsp_interrupt(void);

wasm_debug_transport_t *
wasm_debug_transport_create(void)
{
    wasm_debug_transport_t *transport =
        wasm_runtime_malloc(sizeof(wasm_debug_transport_t));
    if (transport)
        transport->closed = false;
    return transport;
}

int32_t
wasm_debug_transport_read(wasm_debug_transport_t *transport, uint8_t *buffer,
                          uint32_t length, int32_t timeout_ms)
{
    if (!transport || transport->closed)
        return WASM_DEBUG_TRANSPORT_CLOSED;
    return wasm_idle_rsp_read(buffer, length, timeout_ms);
}

int32_t
wasm_debug_transport_write(wasm_debug_transport_t *transport,
                           const uint8_t *buffer, uint32_t length,
                           int32_t timeout_ms)
{
    if (!transport || transport->closed)
        return WASM_DEBUG_TRANSPORT_CLOSED;
    return wasm_idle_rsp_write(buffer, length, timeout_ms);
}

bool
wasm_debug_transport_write_all(wasm_debug_transport_t *transport,
                               const uint8_t *buffer, uint32_t length,
                               int32_t timeout_ms)
{
    uint32_t offset = 0;
    while (offset < length) {
        int32_t written = wasm_debug_transport_write(
            transport, buffer + offset, length - offset, timeout_ms);
        if (written <= 0)
            return false;
        offset += (uint32_t)written;
    }
    return true;
}

void
wasm_debug_transport_interrupt(wasm_debug_transport_t *transport)
{
    if (transport && !transport->closed)
        wasm_idle_rsp_interrupt();
}

void
wasm_debug_transport_close(wasm_debug_transport_t *transport)
{
    if (!transport)
        return;
    if (!transport->closed) {
        transport->closed = true;
        wasm_idle_rsp_close();
    }
    wasm_runtime_free(transport);
}
