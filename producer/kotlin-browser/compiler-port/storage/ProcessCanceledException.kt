/* Portable host cancellation marker. It always throws through compiler callers;
 * it does not emulate any IntelliJ service or successful result. */
package com.intellij.openapi.progress

open class ProcessCanceledException : RuntimeException()
