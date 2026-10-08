/* Test observer only; reflection reads the actual source-compiled class. */
import java.lang.reflect.*;
import java.util.*;

public final class Reference {
    public static void main(String[] args) throws Exception {
        Class<?> type = Class.forName("org.jetbrains.kotlin.builtins.KotlinBuiltIns");
        List<String> records = new ArrayList<>();
        for (Constructor<?> constructor : type.getDeclaredConstructors()) {
            if (!visible(constructor.getModifiers())) continue;
            records.add("constructor:" + Modifier.toString(constructor.getModifiers()) + ":" + parameters(constructor.getParameterTypes()));
        }
        for (Method method : type.getDeclaredMethods()) {
            if (!visible(method.getModifiers()) || method.isSynthetic()) continue;
            records.add("method:" + Modifier.toString(method.getModifiers()) + ":" + method.getName() +
                    ":" + method.getReturnType().getName() + ":" + parameters(method.getParameterTypes()));
        }
        for (Field field : type.getDeclaredFields()) {
            if (!visible(field.getModifiers()) || field.isSynthetic()) continue;
            records.add("field:" + Modifier.toString(field.getModifiers()) + ":" + field.getName() + ":" + field.getType().getName());
        }
        Collections.sort(records);
        for (String record : records) System.out.println(record);
    }
    private static boolean visible(int modifiers) { return Modifier.isPublic(modifiers) || Modifier.isProtected(modifiers); }
    private static String parameters(Class<?>[] types) {
        List<String> result = new ArrayList<>();
        for (Class<?> type : types) result.add(type.getName());
        return String.join(",", result);
    }
}
