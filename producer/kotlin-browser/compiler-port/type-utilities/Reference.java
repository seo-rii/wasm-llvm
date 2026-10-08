import java.lang.reflect.*;
import java.util.*;

/** Observes genuine class visibility, erased APIs, and instance dispatch. */
public final class Reference {
    public static void main(String[] args) throws Exception {
        for (String name : args) {
            Class<?> cls = Class.forName(name);
            TreeSet<String> records = new TreeSet<>();
            records.add("class:" + Modifier.toString(cls.getModifiers()) + ":" + cls.getSuperclass().getName());
            for (Constructor<?> constructor : cls.getDeclaredConstructors()) {
                if (!Modifier.isPublic(constructor.getModifiers()) && !Modifier.isProtected(constructor.getModifiers())) continue;
                records.add("constructor:" + Modifier.toString(constructor.getModifiers()) + ":" + parameters(constructor.getParameterTypes()));
            }
            for (Method method : cls.getDeclaredMethods()) {
                if ((!Modifier.isPublic(method.getModifiers()) && !Modifier.isProtected(method.getModifiers())) || method.isSynthetic()) continue;
                records.add("method:" + Modifier.toString(method.getModifiers()) + ":" + method.getName() + parameters(method.getParameterTypes()) + ":" + method.getReturnType().getName());
            }
            for (Field field : cls.getDeclaredFields()) if (Modifier.isPublic(field.getModifiers())) {
                records.add("field:" + Modifier.toString(field.getModifiers()) + ":" + field.getName() + ":" + field.getType().getName());
            }
            for (String record : records) System.out.println(name + "\t" + record);
        }
    }
    private static String parameters(Class<?>[] classes) {
        StringJoiner result = new StringJoiner(",", "(", ")");
        for (Class<?> cls : classes) result.add(cls.getName());
        return result.toString();
    }
}
