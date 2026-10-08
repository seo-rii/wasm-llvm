The MavenComparableVersion and Kotlin source adaptations retain the upstream
Apache License 2.0 notices. The Kotlin source license is
<https://github.com/JetBrains/kotlin/blob/4d78aae1e337cd40f69baa865aed950fe807a775/license/LICENSE.txt>.

`VersionUnicode.kt` adapts the OpenJDK 17 `ConditionalSpecialCasing` fixed
English/ROOT final-casing branch and `RuleBasedBreakIterator` forward word
boundary algorithm. They are licensed under the GNU General Public License
version 2 with the Classpath exception:
<https://github.com/openjdk/jdk17u/blob/jdk-17.0.15%2B6/LICENSE> and
<https://github.com/openjdk/jdk17u/blob/jdk-17.0.15%2B6/ADDITIONAL_LICENSE_INFO>.
Complete unmodified texts are included in
[LICENSE-GPL2-with-classpath-exception.txt](LICENSE-GPL2-with-classpath-exception.txt)
and [OPENJDK-ADDITIONAL-LICENSE-INFO.txt](OPENJDK-ADDITIONAL-LICENSE-INFO.txt).
Modification notice (2026-10-08): the fixed English/ROOT character policy and
word-boundary state-machine paths were adapted to common Kotlin; JVM iterators,
reflection and resource lookup were moved to the CI capture boundary. Their
copyright and attribution notices remain here and on the adapted source.
Its word iterator attribution is retained here:

> (C) Copyright Taligent, Inc. 1996, 1997 - All Rights Reserved
> (C) Copyright IBM Corp. 1996 - 2002 - All Rights Reserved
>
> The original version of this source code and documentation is copyrighted
> and owned by Taligent, Inc., a wholly-owned subsidiary of IBM. These
> materials are provided under terms of a License Agreement between Taligent
> and Sun. This technology is protected by multiple US and International
> patents. This notice and attribution to Taligent may not be removed.
> Taligent is a registered trademark of Taligent, Inc.

`unicode-policy.json` records the selected reference JDK's character and word
state tables, captured by the CI-only `GenerateUnicodePolicy.java`. It is
covered by the same OpenJDK GPL 2 with Classpath exception license. Generated
Kotlin source carries its data identity and stays in `out/`. Distribution must
include these notices and the applicable complete license texts. Browser
compiler release licensing remains a required release gate.
