/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.charset.StandardCharsets;
import java.util.Base64;

/** Captures every UTF-16 category used by the pinned ES5 identifier body. */
public final class CharacterPolicy {
    public static void main(String[] arguments) throws Exception {
        if (arguments.length != 1) throw new IllegalArgumentException("Expected unique policy output");
        byte[] types = new byte[65536];
        for (int c = 0; c < types.length; c++) types[c] = (byte) Character.getType((char)c);
        String runtime = System.getProperty("java.runtime.version");
        String value = "{\"schemaVersion\":1,\"kind\":\"jdk17-js-es5-identifier-character-policy\","
            + "\"javaRuntimeVersion\":\"" + runtime + "\",\"characters\":65536,\"categoryBytesBase64\":\""
            + Base64.getEncoder().encodeToString(types) + "\"}\n";
        Files.writeString(Path.of(arguments[0]), value, StandardCharsets.UTF_8,
            java.nio.file.StandardOpenOption.CREATE_NEW, java.nio.file.StandardOpenOption.WRITE);
        System.out.println("Captured 65536 original JDK UTF-16 categories at " + runtime);
    }
}
