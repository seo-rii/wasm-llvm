import { json, responseBytes, sha256 } from './source.mjs';

const property = (text, key) => text.split(/\r?\n/).find((line) => line.startsWith(key + '='))?.slice(key.length + 1) ?? null;
const text = (files, filename) => {
  if (!files.has(filename)) throw new Error('Tool declaration source must be locked: ' + filename);
  return files.get(filename).toString('utf8');
};

function checksum(xml, name, version, artifact) {
  for (const component of xml.matchAll(/<component\b([^>]*)>([\s\S]*?)<\/component>/g)) {
    if (!component[1].includes(`name="${name}"`) || !component[1].includes(`version="${version}"`)) continue;
    for (const item of component[2].matchAll(/<artifact\b([^>]*)>([\s\S]*?)<\/artifact>/g)) {
      if (item[1].includes(`name="${artifact}"`)) return /<sha256\s+value="([a-f0-9]{64})"/.exec(item[2])?.[1] ?? null;
    }
  }
  return null;
}

export function verifyToolDeclarations(lock, files) {
  for (const tool of lock.toolAndArtifactDeclarations ?? []) {
    if (tool.name === 'published-module-metadata') {
      if (tool.artifactBytesVerified !== false) throw new Error('Module metadata cannot verify artifact bytes');
      continue;
    }
    const input = text(files, tool.sourcePath);
    let version = null;
    let hash = null;
    if (tool.name === 'bootstrap-compiler') version = property(input, 'bootstrap.kotlin.default.version');
    else if (tool.name === 'gradle') {
      version = /gradle-([^/]+)-bin\.zip/.exec(property(input, 'distributionUrl') ?? '')?.[1] ?? null;
      hash = property(input, 'distributionSha256Sum');
      if (hash !== tool.declaredArchiveSha256) throw new Error('Gradle declared checksum mismatch');
    } else if (tool.name === 'daemon-jdk') version = property(input, 'toolchainVersion');
    else if (tool.name === 'jflex') {
      version = property(input, 'versions.jflex');
      hash = checksum(text(files, tool.verificationSource), 'jflex', version, `jflex-${version}.jar`);
      if (hash !== tool.declaredJarSha256) throw new Error('JFlex declared checksum mismatch');
    } else if (tool.name === 'syntax-api-wasm-js') {
      version = /^org-jetbrains-syntax-api\s*=\s*"([^"]+)"\s*$/m.exec(input)?.[1] ?? null;
      hash = checksum(text(files, tool.verificationSource), 'syntax-api-wasm-js', version, `syntax-api-wasm-js-${version}.klib`);
      if (hash !== tool.declaredKlibSha256) throw new Error('Syntax API declared checksum mismatch');
    } else throw new Error('Unknown tool declaration: ' + tool.name);
    if (!version || version !== tool.version || tool.artifactBytesVerified !== false) {
      throw new Error('Tool version/verification claim mismatch: ' + tool.name);
    }
  }
}

export function publishedWasmJsVariants(metadata) {
  if (!Array.isArray(metadata.variants)) throw new Error('Malformed Gradle module metadata');
  return metadata.variants.filter((variant) => variant.attributes?.['org.jetbrains.kotlin.wasm.target'] === 'js').map((variant) => ({
    name: variant.name,
    attributes: variant.attributes,
    dependencies: variant.dependencies ?? [],
    availableAt: variant['available-at'] ?? null,
    files: (variant.files ?? []).map((file) => ({ name: file.name, declaredBytes: file.size,
      declaredSha256: file.sha256, artifactBytesVerified: false }))
  }));
}

export async function verifyPublishedMetadata(lock, { fetcher = fetch } = {}) {
  const evidence = [];
  for (const pin of lock.toolAndArtifactDeclarations ?? []) {
    if (pin.name !== 'published-module-metadata') continue;
    if (!pin.url.startsWith('https://packages.jetbrains.team/maven/p/ij/intellij-dependencies/') ||
        !Number.isSafeInteger(pin.metadataBytes) || pin.metadataBytes < 0 || pin.metadataBytes > 1024 * 1024 ||
        !/^[a-f0-9]{64}$/.test(pin.metadataSha256 ?? '')) throw new Error('Invalid published metadata pin');
    // The official repository serves module metadata through a public HTTPS CDN redirect.
    // No credentials are sent, and the complete response must match the locked hash and size.
    const bytes = await responseBytes(pin.url, pin.metadataBytes, fetcher, {}, { publicRedirect: true });
    if (bytes.length !== pin.metadataBytes || sha256(bytes) !== pin.metadataSha256) throw new Error('Published metadata content mismatch');
    const variants = publishedWasmJsVariants(JSON.parse(bytes.toString('utf8')));
    if (json(variants) !== json(pin.publishedWasmJsVariants)) throw new Error('Published variant declaration mismatch');
    evidence.push({ url: pin.url, bytes: bytes.length, sha256: sha256(bytes), status: 'pass',
      publishedWasmJsVariants: variants, selectedGradleVariant: null, artifactBytesVerified: false });
  }
  return evidence;
}
