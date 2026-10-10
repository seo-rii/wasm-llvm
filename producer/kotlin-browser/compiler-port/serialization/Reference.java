package org.jetbrains.kotlin.protobuf.probe;

import java.lang.reflect.InvocationTargetException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.jetbrains.kotlin.protobuf.*;
import org.jetbrains.kotlin.metadata.builtins.BuiltInsProtoBuf;
import org.jetbrains.kotlin.metadata.SerializationPluginMetadataExtensions;
import org.jetbrains.kotlin.library.metadata.KlibMetadataProtoBuf;

/** Selected upstream generated Java classes, relocated original protobuf2 runtime. */
public final class Reference {
  static final ExtensionRegistryLite REGISTRY = ExtensionRegistryLite.newInstance();
  static { BuiltInsProtoBuf.registerAllExtensions(REGISTRY); KlibMetadataProtoBuf.registerAllExtensions(REGISTRY); SerializationPluginMetadataExtensions.registerAllExtensions(REGISTRY); }
  public static void main(String[] args) throws Exception {
    Path manifest = Path.of(args[0]);
    Path base = manifest.getParent();
    for (String line : Files.readAllLines(manifest)) {
      if (line.isEmpty()) continue;
      String[] parts = line.split("\t");
      byte[] bytes = Files.readAllBytes(base.resolve(parts[2]));
      try {
        Class<?> type = Class.forName(parts[1]);
        Parser<?> parser = (Parser<?>) type.getField("PARSER").get(null);
        CodedInputStream input = CodedInputStream.newInstance(bytes);
        input.setRecursionLimit(Integer.parseInt(parts[5]));
        MessageLite value = (MessageLite) parser.parsePartialFrom(input, parts[4].equals("true") ? REGISTRY : ExtensionRegistryLite.getEmptyRegistry());
        input.checkLastTagWas(0);
        if (!parts[3].equals("true") && !value.isInitialized()) throw new InvalidProtocolBufferException("Missing required fields");
        System.out.println(parts[0]+"\tok\t"+hex(value.toByteArray()));
      } catch (UninitializedMessageException error) {
        System.out.println(parts[0]+"\terror\tUninitializedMessageException");
      } catch (InvalidProtocolBufferException error) {
        System.out.println(parts[0]+"\terror\tInvalidProtocolBufferException");
      }
    }
  }
  static String hex(byte[] bytes) { StringBuilder s = new StringBuilder();for(byte b:bytes)s.append("0123456789abcdef".charAt((b>>>4)&15)).append("0123456789abcdef".charAt(b&15));return s.toString(); }
}
