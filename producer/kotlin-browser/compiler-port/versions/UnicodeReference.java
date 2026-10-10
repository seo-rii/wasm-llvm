/* Test-only bridge to real JVM character/locale APIs; not a compiler replacement. */
package org.jetbrains.kotlin.portable.versions.probe;
import java.util.Locale;
public final class UnicodeReference {
    public static String lower(String text) { return text.toLowerCase(Locale.ROOT); }
    public static int digit(char ch) { return Character.isDigit(ch) ? Character.digit(ch, 10) : -1; }
}
