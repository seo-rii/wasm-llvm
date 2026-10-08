import java.lang.reflect.*;
import java.util.*;

/** Reflects the actual selected Kotlin/JVM class API; no collection algorithm replacement. */
public final class Reference {
    public static void main(String[] args) throws Exception {
        Class<?> cls = Class.forName("org.jetbrains.kotlin.utils.SmartSet");
        TreeSet<String> records = new TreeSet<>();
        records.add("class:" + Modifier.toString(cls.getModifiers()) + ":" + cls.getSuperclass().getName());
        for (Method method : cls.getDeclaredMethods()) {
            if ((!Modifier.isPublic(method.getModifiers()) && !Modifier.isProtected(method.getModifiers())) || method.isSynthetic()) continue;
            StringJoiner parameters = new StringJoiner(",", "(", ")");
            for (Class<?> parameter : method.getParameterTypes()) parameters.add(parameter.getName());
            records.add("method:" + Modifier.toString(method.getModifiers()) + ":" + method.getName() + parameters + ":" + method.getReturnType().getName());
        }
        for (Field field : cls.getDeclaredFields()) if (Modifier.isPublic(field.getModifiers())) {
            records.add("field:" + Modifier.toString(field.getModifiers()) + ":" + field.getName() + ":" + field.getType().getName());
        }
        for (String record : records) System.out.println(record);
    }
}
