import fs from 'fs';

const path = 'docs/assets/social-preview.svg';
let content = fs.readFileSync(path, 'utf8');

// Fix already duplicated text first
content = content.replace(/gentle-shell gentle-shell & Pi Pi/g, 'gentle-shell & Pi');
content = content.replace(/Fold Fold & collapse collapse/g, 'Fold & collapse');

// Now escape the & properly using Unicode escape for the leading &
// \u0026 = &, then "amp;" literally
const ampEntity = '\u0026amp;';

content = content.replace(/gentle-shell & Pi/g, 'gentle-shell ' + ampEntity + ' Pi');
content = content.replace(/Fold & collapse/g, 'Fold ' + ampEntity + ' collapse');

fs.writeFileSync(path, content);
console.log('Fixed SVG entities');