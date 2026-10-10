import java.lang.reflect.*;
import java.util.*;

/** Observes source-declared erased APIs; no compiler types are recreated. */
public final class Reference {
    public static void main(String[] args) throws Exception {
        for (String name : args) {
            Class<?> cls = Class.forName(name);
            TreeSet<String> entries = new TreeSet<>();
            for (Constructor<?> constructor : cls.getDeclaredConstructors()) {
                if (!Modifier.isPublic(constructor.getModifiers()) && !Modifier.isProtected(constructor.getModifiers())) continue;
                entries.add("constructor:" + Modifier.toString(constructor.getModifiers()) + ":" + parameters(constructor.getParameterTypes()));
            }
            for (Method method : cls.getDeclaredMethods()) {
                if (!Modifier.isPublic(method.getModifiers()) || method.isSynthetic()) continue;
                entries.add("method:" + Modifier.toString(method.getModifiers()) + ":" + method.getName() + parameters(method.getParameterTypes()) + ":" + method.getReturnType().getName());
            }
            for (Field field : cls.getDeclaredFields()) {
                if (!Modifier.isPublic(field.getModifiers())) continue;
                entries.add("field:" + Modifier.toString(field.getModifiers()) + ":" + field.getName() + ":" + field.getType().getName());
            }
            for (String entry : entries) System.out.println(name + "\t" + entry);
        }
    }
    private static String parameters(Class<?>[] values) {
        StringJoiner result = new StringJoiner(",", "(", ")");
        for (Class<?> value : values) result.add(value.getName());
        return result.toString();
    }
}
