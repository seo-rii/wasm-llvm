/*
 * Copyright (C) 2026 wasm-idle contributors.
 * SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception
 */

#ifndef WASM_IDLE_DEBUG_TRANSPORT_H
#define WASM_IDLE_DEBUG_TRANSPORT_H

#include <stdbool.h>
#include <stdint.h>

typedef struct wasm_debug_transport wasm_debug_transport_t;

#define WASM_DEBUG_TRANSPORT_ERROR (-1)
#define WASM_DEBUG_TRANSPORT_CLOSED (-2)
#define WASM_DEBUG_TRANSPORT_TIMED_OUT 0

wasm_debug_transport_t *
wasm_debug_transport_create(void);

int32_t
wasm_debug_transport_read(wasm_debug_transport_t *transport, uint8_t *buffer,
                          uint32_t length, int32_t timeout_ms);

int32_t
wasm_debug_transport_write(wasm_debug_transport_t *transport,
                           const uint8_t *buffer, uint32_t length,
                           int32_t timeout_ms);

bool
wasm_debug_transport_write_all(wasm_debug_transport_t *transport,
                               const uint8_t *buffer, uint32_t length,
                               int32_t timeout_ms);

void
wasm_debug_transport_interrupt(wasm_debug_transport_t *transport);

void
wasm_debug_transport_close(wasm_debug_transport_t *transport);

#endif
