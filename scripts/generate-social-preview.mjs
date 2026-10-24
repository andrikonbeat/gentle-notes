import sharp from 'sharp';
import fs from 'fs';

const svgPath = 'docs/assets/social-preview.svg';
const pngPath = 'docs/assets/social-preview.png';

const svgBuffer = fs.readFileSync(svgPath);

await sharp(svgBuffer, { density: 300 })
  .resize(1280, 640, { fit: 'fill' })
  .png({ quality: 90, compressionLevel: 6 })
  .toFile(pngPath);

console.log('✅ Social preview PNG created:', pngPath);
const stats = fs.statSync(pngPath);
console.log(`   Size: ${(stats.size / 1024).toFixed(1)} KB`);