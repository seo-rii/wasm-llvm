package org.jetbrains.kotlin.portable.assertioncheck

import kotlin.assert

fun observeAssertions(): String {
    val observations = mutableListOf<String>()
    fun observe(name: String, operation: () -> String) {
        observations += name + "=" + operation()
    }
    fun failure(operation: () -> Unit): String = try {
        operation()
        "no-error"
    } catch (error: AssertionError) {
        "AssertionError:" + error.message
    }
    observe("true") { assert(true); "ok" }
    observe("false") { failure { assert(false) } }
    observe("true-lazy") {
        var calls = 0
        assert(true) { calls++; "unused" }
        calls.toString()
    }
    observe("false-lazy-once") {
        var calls = 0
        val error = failure { assert(false) { calls++; "value" } }
        "$error:$calls"
    }
    observe("empty-message") { failure { assert(false) { "" } } }
    observe("unicode-message") { failure { assert(false) { "한글\uD83D\uDE00\r\nnext" } } }
    observe("number-message") { failure { assert(false) { 42 } } }
    observe("object-message") {
        var rendered = 0
        val message = object {
            override fun toString(): String { rendered++; return "message-object" }
        }
        val error = failure { assert(false) { message } }
        "$error:$rendered"
    }
    observe("message-exception-identity") {
        val original = IllegalStateException("lazy-message-failed")
        try { assert(false) { throw original }; "no-error" }
        catch (error: IllegalStateException) { (error === original).toString() + ":" + error.message }
    }
    observe("condition-exception-identity") {
        val original = IllegalArgumentException("condition-failed")
        fun condition(): Boolean = throw original
        var calls = 0
        try { assert(condition()) { calls++; "unused" }; "no-error" }
        catch (error: IllegalArgumentException) { (error === original).toString() + ":$calls" }
    }
    observe("condition-once") {
        var calls = 0
        fun condition(): Boolean { calls++; return false }
        val error = failure { assert(condition()) { "condition" } }
        "$error:$calls"
    }
    observe("evaluation-order") {
        val events = mutableListOf<String>()
        fun condition(): Boolean { events += "condition"; return false }
        val error = failure { assert(condition()) { events += "message"; "ordered" } }
        "$error:" + events.joinToString(",")
    }
    observe("nested-message-assertion") {
        failure { assert(false) { assert(false) { "inner" }; "outer" } }
    }
    observe("message-conversion-exception") {
        val original = IllegalStateException("render-failed")
        val message = object { override fun toString(): String = throw original }
        try { assert(false) { message }; "no-error" }
        catch (error: IllegalStateException) { (error === original).toString() + ":" + error.message }
    }
    observe("inline-non-local-return") {
        fun selected(): String { assert(false) { return "returned" }; return "unreachable" }
        selected()
    }
    observe("after-failure") {
        val error = failure { assert(false) { "first" } }
        assert(true)
        "$error:recovered"
    }
    return observations.joinToString("\n")
}
