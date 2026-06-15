import { Transport } from './http'
import type {
    DownloadResult,
    ListResult,
    PresignResult,
    StorageBucket,
    StorageObject,
    TemporaryUrlResult,
    UploadBody,
} from './types'

const STORAGE_PATH = '/api/v1/storage'

const DEFAULT_CONTENT_TYPE = 'application/octet-stream'

/** Normalize whatever the caller hands us into a Blob for multipart upload. */
function toBlob(body: UploadBody, contentType: string): Blob {
    if (body instanceof Blob) return body
    if (typeof body === 'string') return new Blob([body], { type: contentType })
    if (body instanceof ArrayBuffer) return new Blob([body], { type: contentType })
    if (ArrayBuffer.isView(body)) {
        return new Blob([body as unknown as BlobPart], { type: contentType })
    }
    throw new TypeError('upload expects a Blob, ArrayBuffer, typed array, or string')
}

function fileName(path: string): string {
    return path.split('/').filter(Boolean).pop() ?? path
}

/** Operations available on both buckets. */
export class BucketClient {
    constructor(
        protected readonly transport: Transport,
        protected readonly bucket: StorageBucket
    ) {}

    protected op<T>(operation: string, params: Record<string, unknown> = {}): Promise<T> {
        return this.transport.json<T>(STORAGE_PATH, { operation, bucket: this.bucket, ...params })
    }

    /** List objects under `prefix`. */
    list(prefix?: string): Promise<ListResult> {
        return this.op<ListResult>('list', { prefix })
    }

    /** Delete one or more objects. Returns `{ deleted }`. */
    remove(paths: string[]): Promise<{ deleted: number }> {
        return this.op<{ deleted: number }>('remove', { paths })
    }

    /** Move/rename an object within the bucket. */
    move(from: string, to: string): Promise<{ object: StorageObject }> {
        return this.op<{ object: StorageObject }>('move', { from, to })
    }

    createFolder(path: string): Promise<{ created: string }> {
        return this.op<{ created: string }>('createFolder', { path })
    }

    /** Download an object inline (≤ 8 MB). Use `getTemporaryUrl` for larger files. */
    download(path: string): Promise<DownloadResult> {
        return this.op<DownloadResult>('download', { path })
    }

    /** A short-lived signed URL (default 300s, max 7 days). */
    getTemporaryUrl(path: string, expiresIn?: number): Promise<TemporaryUrlResult> {
        return this.op<TemporaryUrlResult>('getTemporaryUrl', { path, expiresIn })
    }

    /** A presigned PUT URL for direct, large uploads (≤ no inline limit). */
    presignUpload(path: string, contentType?: string): Promise<PresignResult> {
        return this.op<PresignResult>('presignUpload', { path, contentType })
    }

    /** Upload bytes directly (≤ 100 MB). For larger files, `presignUpload`
     *  then PUT to the returned URL yourself. */
    upload(
        path: string,
        body: UploadBody,
        contentType: string = DEFAULT_CONTENT_TYPE
    ): Promise<{ object: StorageObject }> {
        const form = new FormData()
        form.append('file', toBlob(body, contentType), fileName(path))
        form.append('bucket', this.bucket)
        form.append('path', path)
        form.append('contentType', contentType)
        return this.transport.multipart<{ object: StorageObject }>(STORAGE_PATH, form)
    }
}

/** The public bucket additionally exposes stable public URLs. */
export class PublicBucketClient extends BucketClient {
    constructor(transport: Transport) {
        super(transport, 'public')
    }

    /** The permanent public URL for an object. */
    getUrl(path: string): Promise<{ url: string }> {
        return this.op<{ url: string }>('getUrl', { path })
    }
}

export interface StorageClient {
    public: PublicBucketClient
    private: BucketClient
}

export function createStorage(transport: Transport): StorageClient {
    return {
        public: new PublicBucketClient(transport),
        private: new BucketClient(transport, 'private'),
    }
}
