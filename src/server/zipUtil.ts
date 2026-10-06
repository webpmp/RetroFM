import AdmZip from 'adm-zip';
import path from 'path';
import fs from 'fs';

export function createZipFromDirectory(dirPath: string): Buffer {
  const zip = new AdmZip();

  // Add the contents of the extension directory so they unpack into a clean directory
  if (fs.existsSync(dirPath)) {
    zip.addLocalFolder(dirPath);
  } else {
    throw new Error(`Directory not found: ${dirPath}`);
  }

  return zip.toBuffer();
}
