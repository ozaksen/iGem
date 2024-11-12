/* eslint global-require: off, no-console: off, promise/always-return: off */

/**
 * This module executes inside of electron's main process. You can start
 * electron renderer process from here and communicate with the other processes
 * through IPC.
 *
 * When running `npm run build` or `npm run build:main`, this file is compiled to
 * `./src/main.js` using webpack. This gives us some performance wins.
 */
import path from 'path';
import { app, BrowserWindow, shell, ipcMain, IpcMainInvokeEvent } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import MenuBuilder from './menu';
import { resolveHtmlPath } from './util';
import * as fs from 'fs';
import sqlite3 from 'sqlite3';

import yauzl from 'yauzl';
const knex = require('./db');

interface DeviceData {
  icon: string;
  zipFilePath: string;
  extractDir: string;
  deviceId: Number;
}

interface LocationsObject {
  latitude: number;
  longitude: number;
  speed: string;
  deviceId: number;
  verticalAccuracy: number;
  horizontalAccuracy: number;
  timestamp:number;
}
const IOS_TO_UNIX_EPOCH_OFFSET = 978307200; // Difference in seconds between iOS epoch and Unix epoch


// Convert wildcard pattern to a regular expression
const wildcardToRegex = (pattern: string) => {
  return new RegExp(
    '^' +
    pattern
      .replace(/\//g, '\\/')   // Ensure slashes are interpreted correctly
      .replace(/\./g, '\\.')    // Escape dots
      .replace(/\*/g, '.*')     // Replace * with .*
      .replace(/\?/g, '.') +    // Replace ? with .
    '$'
  );
};

const extractFilesMatchingPath = (zipFilePath: string, extractDir: string, pattern: string) => {
  return new Promise((resolve, reject) => {
    const regexPattern = wildcardToRegex(pattern); // Convert the pattern to regex
    const ktxFolder = path.join(extractDir, 'ktx_files');
    fs.mkdirSync(ktxFolder, { recursive: true }); // Ensure ktx_files folder exists

    yauzl.open(zipFilePath, { lazyEntries: true }, (err, zipFile) => {
      if (err) return reject(err);

      zipFile.readEntry();
      zipFile.on('entry', (entry) => {
        // Check if the entry path matches the regex pattern
        if (regexPattern.test(entry.fileName)) {
          // Set the destination path to the ktx_files folder without any subdirectories
          const entryName = path.basename(entry.fileName); // Only use the file name
          const entryPath = path.join(ktxFolder, entryName);

          zipFile.openReadStream(entry, (err, readStream) => {
            if (err) return reject(err);

            const writeStream = fs.createWriteStream(entryPath);
            readStream.pipe(writeStream);
            readStream.on('end', () => zipFile.readEntry());
            writeStream.on('finish', () => resolve(entryPath));
          });
        } else {
          zipFile.readEntry(); // Skip entries that don’t match the pattern
        }
      });

      zipFile.on('end', () => resolve(`Extraction complete to ${ktxFolder}`));
      zipFile.on('error', reject);
    });
  });
};

// IPC handler to trigger the extraction
ipcMain.handle('extract-matching-files', async (event, zipFilePath, extractDir) => {
  const matchingPathPattern = 'filesystem1/private/var/mobile/Containers/Data/Application/*/Library/SplashBoard/Snapshots/*/*.ktx';
  try {
    const result = await extractFilesMatchingPath(zipFilePath, extractDir, matchingPathPattern);
    return { success: true, message: result };
  } catch (error) {
    return { success: false, message: (error as Error).message };
  }
});
// Handler to retrieve device locations from the database
ipcMain.handle('get-device-locations', async (event, deviceId: number) => {
  try {
    // Query locations based on deviceId
    const locations = await knex('device_locations')
      .select('latitude', 'longitude', 'speed', 'verticalAccuracy', 'horizontalAccuracy', 'timestamp')
      .where({ deviceId });
      
    return { success: true, data: locations };
  } catch (error) {
    console.error('Error fetching device locations:', error);
    return { success: false, error: (error as Error).message };
  }
});

async function extractFileFromZip(zipFilePath: string, targetFilePathInZip: string, outputDir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipFilePath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);

      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        if (entry.fileName === targetFilePathInZip) {
          const extractedFilePath = path.join(outputDir, path.basename(targetFilePathInZip));
          zipfile.openReadStream(entry, (err, readStream) => {
            if (err) return reject(err);

            const writeStream = fs.createWriteStream(extractedFilePath);
            readStream.pipe(writeStream);

            writeStream.on('finish', () => {
              zipfile.close();
              resolve(extractedFilePath); // Path of the extracted file
            });

            writeStream.on('error', (writeErr) => {
              zipfile.close();
              reject(writeErr);
            });
          });
        } else {
          zipfile.readEntry(); // Skip other files
        }
      });

      zipfile.on('end', () => {
        reject(new Error(`File "${targetFilePathInZip}" not found in the ZIP archive.`));
      });

      zipfile.on('error', (zipErr) => {
        reject(zipErr);
      });
    });
  });
}

ipcMain.handle('process-zip-file', async (event: IpcMainInvokeEvent, { icon, zipFilePath, extractDir, deviceId }: DeviceData) => {
  try {
    const targetFilePathInZip = 'filesystem1/private/var/mobile/Library/Caches/com.apple.routined/Cache.sqlite';
    // Create the extraction directory if it doesn't exist
    if (!fs.existsSync(extractDir)) {
      fs.mkdirSync(extractDir, { recursive: true });
    }

    // Extract Cache.sqlite
    const extractedDbPath = await extractFileFromZip(zipFilePath, targetFilePathInZip, extractDir);

    const id = deviceId.id
    // Open the extracted SQLite database and read data from ZRTCLLOCATIONMO
    const cacheDb = new sqlite3.Database(extractedDbPath, sqlite3.OPEN_READONLY, (err) => {
      if (err) throw new Error(`Could not open Cache.sqlite: ${err.message}`);
    });

    const query = `SELECT ZLATITUDE AS latitude, ZLONGITUDE AS longitude, ZSPEED AS speed, 
                          ZVERTICALACCURACY AS verticalAccuracy, ZHORIZONTALACCURACY AS horizontalAccuracy, 
                          ZTIMESTAMP AS timestamp FROM ZRTCLLOCATIONMO`;

    return new Promise((resolve, reject) => {
      cacheDb.all(query, async (err, rows) => {
        if (err) {
          console.error('Error querying ZRTCLLOCATIONMO:', err.message);
          return reject({ success: false, error: err.message });
        }

        // Process each row and adjust the timestamp
        const locationData = rows.map(row => ({
          deviceId: deviceId.id,
          latitude: row.latitude,
          longitude: row.longitude,
          speed: row.speed,
          verticalAccuracy: row.verticalAccuracy,
          horizontalAccuracy: row.horizontalAccuracy,
          timestamp: new Date((row.timestamp + IOS_TO_UNIX_EPOCH_OFFSET) * 1000), // Convert iOS time to Unix time
        }));

        try {
          await knex('device_locations').insert(locationData);
          resolve({ success: true, message: 'Data successfully transferred to device_locations' });
        } catch (insertError) {
          console.error('Error inserting into device_locations:', (insertError as Error).message);
          reject({ success: false, error: (insertError as Error).message });
        } finally {
          cacheDb.close();
        }
      });
    });
  } catch (error) {
    console.error('Error processing ZIP file:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

class AppUpdater {
  constructor() {
    log.transports.file.level = 'info';
    autoUpdater.logger = log;
    autoUpdater.checkForUpdatesAndNotify();
  }
}

let mainWindow: BrowserWindow | null = null;

ipcMain.handle('get-devices', async () => {
  try {
    const data = await knex('devices').select('*');
    return { success: true, data };
  } catch (error) {
    console.error('Error adding device:', error);
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('add-device', async (event, device) => {
  try {
    const [id] = await knex('devices')
      .insert({
        name: device.name,
        icon: device.icon,
        imagePath: device.imagePath,
        created_at: device.created_at,
      })
      .returning('id'); // Use 'returning' to get the inserted ID

    return { success: true, id };
  } catch (error) {
    console.error('Error adding device:', error);
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('remove-device', async (event, deviceId) => {
  try {
    await knex('devices').where('id', deviceId).del();
    return { success: true };
  } catch (error) {
    console.error('Error deleting device:', error);
    return { success: false, error: (error as Error).message };
  }
});




if (process.env.NODE_ENV === 'production') {
  const sourceMapSupport = require('source-map-support');
  sourceMapSupport.install();
}

const isDebug =
  process.env.NODE_ENV === 'development' || process.env.DEBUG_PROD === 'true';

if (isDebug) {
  require('electron-debug')();
}

const installExtensions = async () => {
  const installer = require('electron-devtools-installer');
  const forceDownload = !!process.env.UPGRADE_EXTENSIONS;
  const extensions = ['REACT_DEVELOPER_TOOLS'];

  return installer
    .default(
      extensions.map((name) => installer[name]),
      forceDownload,
    )
    .catch(console.log);
};

const createWindow = async () => {
  if (isDebug) {
    await installExtensions();
  }

  const RESOURCES_PATH = app.isPackaged
    ? path.join(process.resourcesPath, 'assets')
    : path.join(__dirname, '../../assets');

  const getAssetPath = (...paths: string[]): string => {
    return path.join(RESOURCES_PATH, ...paths);
  };

  mainWindow = new BrowserWindow({
    show: false,
    width: 1024,
    height: 728,
    icon: getAssetPath('icon.png'),
    webPreferences: {
      preload: app.isPackaged
        ? path.join(__dirname, 'preload.js')
        : path.join(__dirname, '../../.erb/dll/preload.js'),
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.loadURL(resolveHtmlPath('index.html'));
  mainWindow.setMenuBarVisibility(false)

  mainWindow.on('ready-to-show', () => {
    if (!mainWindow) {
      throw new Error('"mainWindow" is not defined');
    }
    if (process.env.START_MINIMIZED) {
      mainWindow.minimize();
    } else {
      mainWindow.show();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const menuBuilder = new MenuBuilder(mainWindow);
  menuBuilder.buildMenu();

  // Open urls in the user's browser
  mainWindow.webContents.setWindowOpenHandler((edata) => {
    shell.openExternal(edata.url);
    return { action: 'deny' };
  });

  // Remove this if your app does not use auto updates
  // eslint-disable-next-line
  new AppUpdater();
};

/**
 * Add event listeners...
 */

app.on('window-all-closed', () => {
  // Respect the OSX convention of having the application in memory even
  // after all windows have been closed
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app
  .whenReady()
  .then(() => {
    createWindow();
    app.on('activate', () => {
      // On macOS it's common to re-create a window in the app when the
      // dock icon is clicked and there are no other windows open.
      if (mainWindow === null) createWindow();
    });
  })
  .catch(console.log);


  