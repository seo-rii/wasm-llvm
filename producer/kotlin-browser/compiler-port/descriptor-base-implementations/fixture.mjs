import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular } from '../../scripts/source.mjs';
import { VALUE_PARAMETER } from './transform.mjs';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
/** A genuine previously verified visitor preparation; no synthesized descriptor fixture. */
export async function descriptorBaseFixture() {
    const root = path.resolve(process.env.DESCRIPTOR_BASE_VISITOR ?? path.join(REPO, 'out/kotlin-descriptor-visitor-generic-sealed-1791639578844325954/profile'));
    const receiptPath = path.join(root, 'receipt.json'), receipt = JSON.parse(await readRegular(receiptPath));
    const commonSources = receipt.files.map(pin => path.join(root, pin.path));
    const pin = receipt.files.find(pin => pin.path === VALUE_PARAMETER);
    return { descriptorVisitorComponent: { receiptPath, receipt, commonSources }, retainedSources: [{ ...pin, filename: path.join(root, pin.path) }] };
}
