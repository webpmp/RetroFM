import AdmZip from 'adm-zip';
import path from 'path';
import fs from 'fs';

export function createZipFromDirectory(dirPath: string, rootFolderName?: string): Buffer {
  const zip = new AdmZip();

  if (!fs.existsSync(dirPath)) {
    throw new Error(`Directory not found: ${dirPath}`);
  }

  // If a rootFolderName is provided (e.g. "retro-fm-extension-v1.0.5"), place the files inside that folder
  if (rootFolderName) {
    zip.addLocalFolder(dirPath, rootFolderName);
  } else {
    zip.addLocalFolder(dirPath);
  }

  return zip.toBuffer();
}
