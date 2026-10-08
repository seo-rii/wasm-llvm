/* CI-only host-data capture for the exact JVM version-parser reference policy. */
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.text.BreakIterator;
import java.util.Arrays;
import java.util.Locale;

public final class GenerateUnicodePolicy {
    private static Object field(Object object, String name) throws Exception {
        Field field = object.getClass().getDeclaredField(name);
        field.setAccessible(true);
        return field.get(object);
    }

    private static void ints(StringBuilder out, String name, int[] values) {
        out.append('"').append(name).append("\":[");
        for (int index = 0; index < values.length; index++) {
            if (index != 0) out.append(',');
            out.append(values[index]);
        }
        out.append(']');
    }

    private static int[] shorts(Object value) {
        short[] values = (short[]) value;
        int[] result = new int[values.length];
        for (int index = 0; index < values.length; index++) result[index] = values[index];
        return result;
    }

    private static int[] booleans(Object value) {
        boolean[] values = (boolean[]) value;
        int[] result = new int[values.length];
        for (int index = 0; index < values.length; index++) result[index] = values[index] ? 1 : 0;
        return result;
    }

    private static boolean cased(int ch) {
        int type = Character.getType(ch);
        return type == Character.LOWERCASE_LETTER || type == Character.UPPERCASE_LETTER ||
               type == Character.TITLECASE_LETTER ||
               ch >= 0x02b0 && ch <= 0x02b8 || ch >= 0x02c0 && ch <= 0x02c1 ||
               ch >= 0x02e0 && ch <= 0x02e4 || ch == 0x0345 || ch == 0x037a ||
               ch >= 0x1d2c && ch <= 0x1d61 || ch >= 0x2160 && ch <= 0x217f ||
               ch >= 0x24b6 && ch <= 0x24e9;
    }

    public static void main(String[] args) throws Exception {
        if (Runtime.version().feature() != 17) throw new IllegalStateException("This policy capture requires the reference JDK 17");
        BreakIterator iterator = BreakIterator.getWordInstance(Locale.ENGLISH);
        BreakIterator root = BreakIterator.getWordInstance(Locale.ROOT);
        if (!iterator.getClass().getName().equals("sun.text.RuleBasedBreakIterator") ||
            !root.getClass().equals(iterator.getClass()) ||
            !Arrays.equals(shorts(field(iterator, "stateTable")), shorts(field(root, "stateTable")))) {
            throw new IllegalStateException("Unexpected reference English/ROOT word iterator");
        }
        Method category = iterator.getClass().getDeclaredMethod("lookupCategory", int.class);
        category.setAccessible(true);
        StringBuilder digits = new StringBuilder(), lowercase = new StringBuilder(), cases = new StringBuilder(), categories = new StringBuilder();
        int previousCategory = Integer.MIN_VALUE;
        boolean previousCased = false;
        for (int ch = 0; ch <= Character.MAX_CODE_POINT; ch++) {
            if (ch <= Character.MAX_VALUE && Character.isDigit((char) ch)) {
                if (digits.length() != 0) digits.append(',');
                digits.append(ch).append(',').append(Character.digit((char) ch, 10));
            }
            int lower = Character.toLowerCase(ch);
            if (lower != ch) {
                if (lowercase.length() != 0) lowercase.append(',');
                lowercase.append(ch).append(',').append(lower);
            }
            boolean isCased = cased(ch);
            if (isCased != previousCased) {
                if (cases.length() != 0) cases.append(',');
                cases.append(ch).append(',').append(isCased ? 1 : 0);
                previousCased = isCased;
            }
            int currentCategory = (Integer) category.invoke(iterator, ch);
            int rootCategory = (Integer) category.invoke(root, ch);
            if (currentCategory != rootCategory) throw new IllegalStateException("English/ROOT category difference at " + ch);
            if (currentCategory != previousCategory) {
                if (categories.length() != 0) categories.append(',');
                categories.append(ch).append(',').append(currentCategory);
                previousCategory = currentCategory;
            }
        }
        StringBuilder out = new StringBuilder("{\"schemaVersion\":1,\"kind\":\"jdk17-version-parser-unicode-policy\",\"jdkRuntimeVersion\":\"");
        out.append(System.getProperty("java.runtime.version")).append("\",\"digitPairs\":[").append(digits)
            .append("],\"lowercasePairs\":[").append(lowercase).append("],\"casedRanges\":[").append(cases)
            .append("],\"wordCategoryRanges\":[").append(categories).append("],");
        ints(out, "stateTable", shorts(field(iterator, "stateTable"))); out.append(',');
        ints(out, "backwardsStateTable", shorts(field(iterator, "backwardsStateTable"))); out.append(',');
        ints(out, "endStates", booleans(field(iterator, "endStates"))); out.append(',');
        ints(out, "lookaheadStates", booleans(field(iterator, "lookaheadStates"))); out.append('}');
        System.out.println(out);
    }
}
