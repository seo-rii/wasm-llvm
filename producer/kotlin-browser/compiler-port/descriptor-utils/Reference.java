/* Observer only: all descriptors are supplied by genuine compiler metadata. */
import java.lang.reflect.*;
import java.util.*;
public final class Reference {
    public static void main(String[] args) throws Exception {
        Class<?> type = Class.forName("org.jetbrains.kotlin.resolve.DescriptorUtils");
        List<String> output = new ArrayList<>();
        for (Method method : type.getDeclaredMethods()) {
            if (!Modifier.isPublic(method.getModifiers()) || method.isSynthetic()) continue;
            List<String> parameters = new ArrayList<>();
            for (Class<?> parameter : method.getParameterTypes()) parameters.add(parameter.getName());
            output.add("method:" + Modifier.toString(method.getModifiers()) + ":" + method.getName() + ":" + method.getReturnType().getName() + ":" + String.join(",", parameters));
        }
        for (Field field : type.getDeclaredFields()) {
            if (Modifier.isPublic(field.getModifiers()) && !field.isSynthetic()) output.add("field:" + Modifier.toString(field.getModifiers()) + ":" + field.getName() + ":" + field.getType().getName());
        }
        Collections.sort(output); for (String line : output) System.out.println(line);
    }
}
