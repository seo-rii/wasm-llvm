import {declarationReferences} from '../backend-profile/references.mjs';
// A lexical view for legal Kotlin name spellings, not name resolution. Keep raw
// scanning as well so comments and string literals remain conservative edges.
export function lexicalReferenceView(text) {
 let index=0;const chunks=[];
 function quoted(delimiter){chunks.push(delimiter);index+=delimiter.length;while(index<text.length){if(text.startsWith(delimiter,index)){chunks.push(delimiter);index+=delimiter.length;return;}if(delimiter==='"'&&text[index]==='\\'){chunks.push(text.slice(index,index+2));index+=2;continue;}if(text.startsWith('${',index)){chunks.push('${');index+=2;code(true);if(text[index]==='}'){chunks.push('}');index++;}continue;}chunks.push(text[index++]);}}
 function character(){const start=index++;while(index<text.length){if(text[index]==='\\'){index+=2;continue;}if(text[index++]==="'")break;}chunks.push(text.slice(start,index));}
 function code(interpolation=false){let depth=0;while(index<text.length){if(interpolation&&text[index]==='}'&&depth===0)return;if(text.startsWith('//',index)){const end=text.indexOf('\n',index+2);chunks.push(' ');if(end<0){index=text.length;return;}index=end;continue;}if(text.startsWith('/*',index)){let nested=1;index+=2;chunks.push(' ');while(index<text.length&&nested){if(text.startsWith('/*',index)){nested++;index+=2;}else if(text.startsWith('*/',index)){nested--;index+=2;}else{if(text[index]==='\n')chunks.push('\n');index++;}}continue;}if(text.startsWith('"""',index)){quoted('"""');continue;}if(text[index]==='"'){quoted('"');continue;}if(text[index]==="'"){character();continue;}if(interpolation){if(text[index]==='{')depth++;else if(text[index]==='}')depth--;}chunks.push(text[index++]);}}
 code();return chunks.join('').replace(/`([A-Za-z_]\w*)`/g,'$1').replace(/\s*\.\s*/g,'.').replace(/(^|;)[\t\f ]*(package|import)[\t\f ]+/gm,'\n$2 ');
}
export function combinedReferenceText(text){return lexicalReferenceView(text)+'\n'+text;}
export function nativeOutputReferences(text,declaration,view=lexicalReferenceView(text)){return [...new Set([...declarationReferences(text,declaration),...declarationReferences(view,declaration)])];}
