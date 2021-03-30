import * as fs from 'fs-extra'
import * as path from 'path'
import { EventEmitter } from 'events'
import chokidar, { FSWatcher } from 'chokidar'
import { extractStaticData, PendingList } from './utils'
import {
  PagesDataKeeper,
  PagesData,
  Association,
  HandlerAPI,
} from './PagesData'
import { UpdateBuffer } from './UpdateBuffer'

export class PageStrategy extends EventEmitter {
  private fileCache: FileCache = {}
  private watchers = new Set<FSWatcher>()
  private pagesDataKeeper = new PagesDataKeeper()
  private updateBuffer = new UpdateBuffer()
  /**
   * track how many works are pending
   * to avoid returning half-finished page data
   */
  private pendingList = new PendingList()

  constructor(private pagesDir: string, private findPages: FindPages) {
    super()
    const { updateBuffer } = this

    updateBuffer.on('page', (updates: string[]) => {
      this.emit('page', updates)
    })

    updateBuffer.on('page-list', () => {
      this.emit('page-list')
    })
  }

  public start() {
    const helpers = this.createHelpers(() => {
      throw new Error(
        `No defaultFileHandler found. You should pass fileHandler argument when calling watchFiles`
      )
    })
    const { findPages, pendingList, pagesDir } = this
    pendingList.addPending(Promise.resolve(findPages(pagesDir, helpers)))
  }

  public getPages(): Promise<Readonly<PagesData>> {
    return this.pendingList
      .subscribe()
      .then(() => this.pagesDataKeeper.toPagesData())
  }
  public close() {
    this.watchers.forEach((w) => w.close())
  }
  /**
   * Custom PageStrategy can use it to create helpers with custom defaultFileHandler
   */
  protected createHelpers(defaultFileHandler: FileHandler): PageHelpers {
    const apiForCustomSource = this.pagesDataKeeper.createAPIForCustomSource(
      this.updateBuffer.scheduleUpdate.bind(this.updateBuffer)
    )
    const helpers: PageHelpers = {
      extractStaticData,
      watchFiles,
      ...apiForCustomSource,
    }
    const _this = this
    return helpers

    function watchFiles(
      baseDir: string,
      arg2?: string | string[] | FileHandler,
      arg3?: FileHandler
    ) {
      const {
        pagesDir,
        pendingList,
        watchers,
        fileCache,
        updateBuffer,
        pagesDataKeeper,
      } = _this

      // Strip trailing slash and make absolute
      baseDir = path.resolve(pagesDir, baseDir)
      let globs: string[]
      let fileHandler: FileHandler
      if (typeof arg2 === 'function') {
        globs = ['**/*']
        fileHandler = arg2
      } else {
        globs = Array.isArray(arg2) ? arg2 : [arg2 || '**/*']
        fileHandler = arg3 || defaultFileHandler
      }

      // should wait for a complete fs scan
      // before returning the page data
      let fsScanFinish: () => void
      pendingList.addPending(
        new Promise((resolve) => {
          fsScanFinish = resolve
        })
      )
      watchers.add(
        chokidar
          .watch(globs, {
            cwd: baseDir,
            ignored: ['**/node_modules/**/*', '**/.git/**'],
          })
          .on('add', handleFileChange)
          .on('change', handleFileChange)
          .on('unlink', handleFileUnLink)
          .on('ready', () => fsScanFinish())
      )

      async function handleFileChange(filePath: string) {
        filePath = path.join(baseDir, filePath)
        const file =
          fileCache[filePath] ||
          (fileCache[filePath] = new File(filePath, baseDir))
        file.content = null
        // should wait for the fileHandler to finish
        // before returning the page data
        pendingList.addPending(
          updateBuffer.batchUpdate(async (scheduleUpdate) => {
            const handlerAPI = pagesDataKeeper.createAPIForSourceFile(
              file,
              scheduleUpdate
            )
            const pageData = await fileHandler(file, handlerAPI)
            if (pageData) {
              handlerAPI.addPageData(pageData)
            }
          })
        )
      }

      function handleFileUnLink(filePath: string) {
        filePath = path.join(baseDir, filePath)
        const file = fileCache[filePath]
        if (!file) return
        delete fileCache[filePath]
        pendingList.addPending(
          updateBuffer.batchUpdate(async (scheduleUpdate) => {
            pagesDataKeeper.deleteDataAssociatedWithFile(file, scheduleUpdate)
          })
        )
      }
    }
  }
}

export interface FindPages {
  (pagesDir: string, helpers: PageHelpers): void | Promise<void>
}

export interface LoadPageData {
  (file: File, helpers: PageHelpers): PageData | Promise<PageData>
}

export interface PageData {
  /**
   * The page route path.
   * User can register multiple page data with same pageId,
   * as long as they have different keys.
   * Page data with same pageId will be merged.
   *
   * @example '/posts/hello-world'
   */
  readonly pageId: string
  /**
   * The data key.
   * If it conflicts with an already-registered data,
   * error will be thrown.
   *
   * @default 'main'
   */
  readonly key?: string
  /**
   * The path to the runtime data module
   */
  readonly dataPath?: string
  /**
   * The value of static data
   */
  readonly staticData?: any
}

export interface PageHelpers extends HandlerAPI {
  /**
   * Read the static data from a file.
   */
  readonly extractStaticData: (
    file: File
  ) => Promise<{
    readonly [key: string]: any
    readonly sourceType: string
  }>
  /**
   * set page data in the file handler,
   * and file deletion will be handled automatically
   */
  readonly watchFiles: WatchFilesHelper
}

export class File {
  content: Promise<string> | null = null
  // the page data that this file is associated with
  associations: Set<Association> = new Set()
  /** When true, this file will be processed soon */
  queued = false

  constructor(readonly path: string, readonly base: string) {}

  get relative() {
    return path.relative(this.base, this.path)
  }

  get extname() {
    return path.extname(this.path).slice(1)
  }

  read() {
    return this.content || (this.content = fs.readFile(this.path, 'utf-8'))
  }
}

export interface FileHandler {
  (file: File, api: HandlerAPI):
    | void
    | Promise<void>
    | PageData
    | Promise<PageData>
}

export interface WatchFilesHelper {
  /** Watch all files within a directory (except node_modules and .git) */
  (baseDir: string, fileHandler?: FileHandler): void
  /** Watch files matching the given glob */
  (baseDir: string, glob: string, fileHandler?: FileHandler): void
  /** Watch files matching one of the given globs */
  (baseDir: string, globs: string[], fileHandler?: FileHandler): void
}

interface FileCache {
  [filePath: string]: File
}
