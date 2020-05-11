import padStart from 'lodash.padstart';
import { ThreadPool } from '../../../utils';
import BlobStorage from '../../../services/Azure/BlobStorage';

class AzureBlockUpload {
  /**
   * @param {String} url Where to send the file
   * @param {File} file The actual file
   * @param {Object} [opts] Options
   * @param {Number} [opts.blockSize] Block size
   * @param {Object} [opts.callbacks] Callbacks
   * @param {Function} [opts.callbacks.onSuccess] Function to be called when the upload finishes
   * @param {Function} [opts.callbacks.onError] Function to be called when the upload fails
   * @param {Function} [opts.callbacks.onProgress] Function to be called every time the progress changes
   * @param {Number} [opts.simultaneousUploads] Number of simultaneous uploads
   */
  constructor(url, file, opts = {}) {
    if (typeof url !== 'string') {
      throw new Error('url must be a string');
    }

    this.url = url;

    if (!(file instanceof File)) {
      throw new Error('file must be instance of File');
    }

    this.file = file;

    if (opts.blockSize && typeof opts.blockSize !== 'number') {
      throw new Error('blockSize must be a number');
    }

    this.blockSize = opts.blockSize || BlobStorage.BLOCK_MAX_SIZE;

    if (
      opts.simultaneousUploads &&
      typeof opts.simultaneousUploads !== 'number'
    ) {
      throw new Error('simultaneousUploads must be a number');
    }

    this.simultaneousUploads = opts.simultaneousUploads || 3;

    // Callbacks
    const {
      onProgress = () => null,
      onSuccess = () => console.log('success'),
      onError = err => console.error(err),
    } = opts.callbacks || {};

    this.callbacks = {
      onProgress,
      onError,
      onSuccess,
    };

    this.analizeFile();
  }

  /**
   * Do the calculations for knowing how many blocks we are going to use
   */
  analizeFile() {
    const { size, type } = this.file;

    /**
     * Size of file
     */
    this.fileSize = size;

    /**
     * Type of file
     */
    this.fileType = type;

    /**
     * Indicates where in the file we are
     */
    this.currentFilePointer = 0;

    /**
     * Remaining bytes to send
     */
    this.totalRemainingBytes = size;

    // If file is smaller than the block size, block size will be reduced to the file size
    if (size < this.blockSize) {
      this.blockSize = size;
    }

    /**
     * How many blocks we will send
     */
    this.totalBlocks =
      size % this.blockSize === 0
        ? size / this.blockSize
        : Math.ceil(size / this.blockSize);
  }

  /**
   * Read a block as an array buffer
   * @param {Number} from Byte to start reading from
   * @param {Number} to Byte to stop reading
   * @returns {ArrayBuffer}
   */
  async readBlock(from, to) {
    const p = new Promise((resolve, reject) => {
      const reader = new FileReader();

      // Get partial file
      const slicedFile = this.file.slice(from, to);

      reader.onabort = () => reject(new Error('Reading aborted'));
      reader.onerror = () => reject(new Error('file reading has failed'));
      reader.onload = () => {
        const arrayBuffer = reader.result;
        resolve(arrayBuffer);
      };
      reader.readAsArrayBuffer(slicedFile);
    });

    return p;
  }

  /**
   * Start uploading
   */
  async start() {
    const p = new Promise((resolve, reject) => {
      const blockIDList = [];

      const commit = async () =>
        BlobStorage.putBlockList(this.url, blockIDList, this.fileType);

      const job = async nBlock => {
        try {
          const from = nBlock * this.blockSize;
          const to =
            (nBlock + 1) * this.blockSize < this.fileSize
              ? (nBlock + 1) * this.blockSize
              : this.fileSize;

          const blockID = btoa(`chunk${padStart(nBlock, 5)}`);
          blockIDList.push(blockID);

          const blockBuffer = await this.readBlock(from, to);
          const data = new Uint8Array(blockBuffer);

          await BlobStorage.putBlock(this.url, data, blockID);

          const progress = (nBlock + 1) / this.totalBlocks;

          this.totalRemainingBytes -= this.blockSize;

          if (this.totalRemainingBytes < 0) {
            this.totalRemainingBytes = 0;
          }

          if (this.totalRemainingBytes === 0) {
            await commit();
          }

          this.callbacks.onProgress({ progress });

          if (this.totalRemainingBytes === 0) {
            this.callbacks.onSuccess();
            return resolve();
          }
        } catch (error) {
          this.callbacks.onError(error);
          return reject(error);
        }
      };

      const pool = new ThreadPool(this.simultaneousUploads);

      for (let nBlock = 0; nBlock < this.totalBlocks; nBlock += 1) {
        pool.run(() => job(nBlock));
      }
    });

    return p;
  }
}

export default AzureBlockUpload;
