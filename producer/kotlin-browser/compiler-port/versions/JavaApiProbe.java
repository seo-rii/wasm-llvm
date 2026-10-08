/* Real javac client of the selected original/common JVM public member surface. */
package org.jetbrains.kotlin.portable.versions.probe;
import java.lang.reflect.Modifier;
import org.jetbrains.kotlin.config.KotlinCompilerVersion;
import org.jetbrains.kotlin.config.MavenComparableVersion;

public final class JavaApiProbe {
    private static final class VersionSubclass extends KotlinCompilerVersion {}
    private static final class CanonicalSubclass extends MavenComparableVersion {
        CanonicalSubclass(String version) { super(version); }
        @Override public String getCanonical() { return "selected-public-getter-override"; }
    }
    public static void main(String[] args) throws Exception {
        System.out.println(KotlinCompilerVersion.VERSION_FILE_PATH + "|" + KotlinCompilerVersion.VERSION + "|" +
            KotlinCompilerVersion.getVersion() + "|" + KotlinCompilerVersion.isPreRelease() + "|" +
            KotlinCompilerVersion.TEST_IS_PRE_RELEASE_SYSTEM_PROPERTY);
        System.out.println(new VersionSubclass() != null);
        MavenComparableVersion normal = new MavenComparableVersion("1.0-FINAL");
        CanonicalSubclass overridden = new CanonicalSubclass("1.0-FINAL");
        System.out.println(normal.getCanonical() + "|" + overridden.getCanonical() + "|" + normal.equals(overridden) + "|" + normal.compareTo(overridden));
        normal.parseVersion("1.0-rc1");
        System.out.println(normal + "|" + normal.getCanonical() + "|" + normal.hashCode());
        for (String name : new String[]{"getVersion", "isPreRelease"}) {
            System.out.println(name + "|static=" + Modifier.isStatic(KotlinCompilerVersion.class.getMethod(name).getModifiers()));
        }
        for (String name : new String[]{"VERSION", "VERSION_FILE_PATH", "TEST_IS_PRE_RELEASE_SYSTEM_PROPERTY"}) {
            int flags = KotlinCompilerVersion.class.getField(name).getModifiers();
            System.out.println(name + "|static=" + Modifier.isStatic(flags) + "|final=" + Modifier.isFinal(flags));
        }
        System.out.println("parseVersion|final=" + Modifier.isFinal(MavenComparableVersion.class.getMethod("parseVersion", String.class).getModifiers()));
        System.out.println("getCanonical|final=" + Modifier.isFinal(MavenComparableVersion.class.getMethod("getCanonical").getModifiers()));
    }
}
