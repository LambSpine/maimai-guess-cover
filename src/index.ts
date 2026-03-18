import { Context, Schema, h, Logger, Session } from 'koishi'
import fs from 'fs'
import path from 'path'
import sharp from 'sharp'

const logger = new Logger('maimai-guess-cover')

const COVER_DIR = path.join(process.cwd(), 'data', 'maimai-guess-cover')
const STORAGE_DIR = path.join(process.cwd(), 'data', 'maimai-guess-cover-game')
const STORAGE_FILE = path.join(STORAGE_DIR, 'game-cache.json')

if (!fs.existsSync(STORAGE_DIR)) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true })
}

export const name = 'maimai-guess-cover'

export interface Config {
  musicDataUrl: string
  aliasDataUrl: string
}

export const Config: Schema<Config> = Schema.object({
  musicDataUrl: Schema.string()
    .default('https://www.diving-fish.com/api/maimaidxprober/music_data')
    .description('歌曲数据 API 地址'),
  aliasDataUrl: Schema.string()
    .default('https://oss.lista233.cn/alias.json')
    .description('别名数据 API 地址'),
})

interface SongData {
  id: string
  title: string
  type: string
  ds: number[]
  level: string[]
  basic_info: {
    title: string
    artist: string
    genre: string
    bpm: string
    from: string
    is_new: boolean
  }
}

interface AliasData {
  SongID: number
  Name: string
  Alias: string[]
}

interface GameCache {
  musicData: SongData[]
  aliasData: AliasData[]
  lastUpdate: number
}

interface CoverGame {
  channelId: string
  songId: string
  songTitle: string
  startTime: number
  active: boolean
  size: number
  blur: number
  greyscale: boolean
  timerId: NodeJS.Timeout | null
}

function loadCache(): GameCache {
  try {
    if (fs.existsSync(STORAGE_FILE)) {
      const data = fs.readFileSync(STORAGE_FILE, 'utf-8')
      return JSON.parse(data)
    }
  } catch (error) {
    logger.error('加载缓存失败:', error)
  }
  return { musicData: [], aliasData: [], lastUpdate: 0 }
}

function saveCache(cache: GameCache) {
  try {
    fs.writeFileSync(STORAGE_FILE, JSON.stringify(cache, null, 2))
  } catch (error) {
    logger.error('保存缓存失败:', error)
  }
}

async function fetchMusicData(): Promise<SongData[]> {
  const response = await fetch('https://www.diving-fish.com/api/maimaidxprober/music_data')
  return await response.json()
}

async function fetchAliasData(): Promise<AliasData[]> {
  try {
    const response = await fetch('https://oss.lista233.cn/alias.json')
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`)
    }
    const data = await response.json()
    if (Array.isArray(data)) {
      return data
    }
    return data.content || []
  } catch (error) {
    logger.error('获取别名数据失败:', error)
    return []
  }
}

function getSongsWithCover(musicData: SongData[]): SongData[] {
  if (!fs.existsSync(COVER_DIR)) {
    return []
  }
  const coverFiles = fs.readdirSync(COVER_DIR).filter(f => f.endsWith('.jpg'))
  const coverIds = new Set(coverFiles.map(f => f.replace('.jpg', '')))
  return musicData.filter(song => {
    const paddedSongId = song.id.toString().padStart(5, '0')
    return coverIds.has(paddedSongId)
  })
}

async function cropCoverImage(songId: string, size: number, blur: number, greyscale: boolean): Promise<Buffer | null> {
  const paddedSongId = songId.toString().padStart(5, '0')
  const coverPath = path.join(COVER_DIR, `${paddedSongId}.jpg`)
  if (!fs.existsSync(coverPath)) {
    return null
  }

  try {
    const image = sharp(coverPath)
    const metadata = await image.metadata()
    
    if (!metadata.width || !metadata.height) {
      return null
    }

    const maxSize = Math.min(metadata.width, metadata.height)
    const actualSize = Math.min(size, maxSize)
    
    const x = Math.floor(Math.random() * (metadata.width - actualSize))
    const y = Math.floor(Math.random() * (metadata.height - actualSize))

    let imageProcess = image
      .extract({ left: x, top: y, width: actualSize, height: actualSize })
    
    // 应用黑白效果
    if (greyscale) {
      imageProcess = imageProcess.grayscale()
    }
    
    // 应用模糊效果
    if (blur > 0) {
      imageProcess = imageProcess.blur(blur)
    }
    
    const croppedBuffer = await imageProcess
      .jpeg()
      .toBuffer()

    return croppedBuffer
  } catch (error) {
    logger.error(`裁剪封面失败: ${songId}`, error)
    return null
  }
}

const games = new Map<string, CoverGame>()

export function apply(ctx: Context, config: Config) {
  const gameCache = loadCache()

  // 查找歌曲别名
  function findSongAlias(songId: string, songTitle: string) {
    const aliasInfo = (gameCache.aliasData || []).find(alias => alias.SongID.toString() === songId)
    let aliasText = ''
    if (aliasInfo) {
      const aliases = [aliasInfo.Name, ...aliasInfo.Alias].filter(Boolean).filter(a => a !== songTitle)
      if (aliases.length > 0) {
        aliasText = `\n别名: ${aliases.join('、')}`
      }
    }
    return aliasText
  }

  // 构建公布答案的消息
  function buildAnswerMessage(prefix: string, songId: string, songTitle: string, timeUsed?: number) {
    const aliasText = findSongAlias(songId, songTitle)
    const paddedSongId = songId.toString().padStart(5, '0')
    const coverPath = path.join(COVER_DIR, `${paddedSongId}.jpg`)
    const elements: (string | ReturnType<typeof h.image>)[] = [
      prefix,
      `${songTitle} (ID: ${songId})${aliasText}`
    ]
    
    // 添加用时信息（如果提供）
    if (timeUsed !== undefined) {
      elements.push(`\n用时: ${timeUsed} 秒`)
    }
    
    if (fs.existsSync(coverPath)) {
      elements.push(h.image('file:///' + coverPath.replace(/\\/g, '/')))
    }
    
    return elements
  }

  const coverCmd = ctx.command('cover', 'maimai 猜曲绘相关命令')

  coverCmd.subcommand('.refresh', '刷新歌曲数据')
    .action(async ({ session }) => {
      if (!session) return

      try {
        await session.send('正在获取歌曲数据，请稍候...')
        const [musicData, aliasData] = await Promise.all([
          fetchMusicData(),
          fetchAliasData()
        ])
        gameCache.musicData = musicData
        gameCache.aliasData = aliasData
        gameCache.lastUpdate = Date.now()
        saveCache(gameCache)

        const songsWithCover = getSongsWithCover(musicData)
        return [
          '歌曲数据刷新成功！',
          `共获取 ${musicData.length} 首歌曲`,
          `共获取 ${aliasData.length} 条别名数据`,
          `其中 ${songsWithCover.length} 首有封面`,
          `更新时间: ${new Date().toLocaleString('zh-CN')}`
        ].join('\n')
      } catch (error) {
        logger.error('刷新歌曲数据失败:', error)
        return '刷新歌曲数据失败，请稍后重试'
      }
    })

  coverCmd.subcommand('.guess', '猜曲绘游戏')
    .alias('猜曲绘')
    .option('size', '-s <size:number> 截取正方形边长像素，默认120，范围1~400')
    .option('blur', '-b <blur:number> 模糊程度，范围0.3~1000')
    .option('greyscale', '-g 启用黑白效果')
    .action(async ({ session, options }) => {
      if (!session) return

      const channelId = session.channelId || session.guildId || 'private'
      const size = options?.size || 120
      const blur = options?.blur !== undefined ? Number(options.blur) : 0
      const greyscale = options?.greyscale || false

      // 验证尺寸范围 1~400
      if (size < 1 || size > 400) {
        return '裁剪尺寸必须在 1~400 之间'
      }

      // 验证模糊程度范围 0.3~1000
      if (blur > 0 && (blur < 0.3 || blur > 1000)) {
        return '模糊程度必须在 0.3~1000 之间'
      }

      if (gameCache.musicData.length === 0) {
        return '歌曲数据库为空，请先使用 cover.refresh 命令刷新数据'
      }

      const songsWithCover = getSongsWithCover(gameCache.musicData)
      if (songsWithCover.length === 0) {
        return '没有找到有封面的歌曲，请检查封面目录'
      }

      if (games.has(channelId)) {
        return '当前已有进行中的猜曲绘游戏，请先回答或等待超时'
      }

      const randomSong = songsWithCover[Math.floor(Math.random() * songsWithCover.length)]
      logger.info(`[调试] 随机选择曲绘: ${randomSong.title} (ID: ${randomSong.id}), 裁剪尺寸: ${size}x${size}, 模糊程度: ${blur}, 黑白: ${greyscale}`)
      
      const croppedImage = await cropCoverImage(randomSong.id, size, blur, greyscale)
      
      if (!croppedImage) {
        logger.error(`[调试] 生成裁剪图片失败: ${randomSong.title} (ID: ${randomSong.id})`)
        return '生成裁剪图片失败，请检查参数'
      }
      
      logger.info(`[调试] 生成裁剪图片成功: ${randomSong.title} (ID: ${randomSong.id})`)

      const game: CoverGame = {
        channelId,
        songId: randomSong.id,
        songTitle: randomSong.title,
        startTime: Date.now(),
        active: true,
        size,
        blur,
        greyscale,
        timerId: null
      }

      games.set(channelId, game)

      await session.send([
        `猜曲绘游戏开始！`,
        `截取大小: ${size}x${size} 像素\n`,
        `请猜出这是哪首歌的封面`,
        h.image(croppedImage, 'image/jpeg')
      ])

      const timerId = setTimeout(() => {
        const currentGame = games.get(channelId)
        if (currentGame && currentGame.active) {
          const elements = buildAnswerMessage('时间到！正确答案是：', randomSong.id, randomSong.title)
          games.delete(channelId)
          session.send(elements)
        }
      }, 60000)

      // 保存定时器ID到游戏对象
      game.timerId = timerId

      return
    })

  coverCmd.subcommand('.answer', '提前公布答案')
    .action(async ({ session }) => {
      if (!session) return

      const channelId = session.channelId || session.guildId || 'private'
      const game = games.get(channelId)

      if (!game || !game.active) {
        return '当前没有进行中的猜曲绘游戏'
      }

      // 清除定时器
      if (game.timerId) {
        clearTimeout(game.timerId)
        logger.info(`[调试] 清除定时器: ${game.songTitle} (ID: ${game.songId})`)
      }

      // 公布答案
      const elements = buildAnswerMessage('提前公布答案！正确答案是：', game.songId, game.songTitle)
      games.delete(channelId)
      return elements
    })

  // 处理匹配成功的函数
  function handleMatchSuccess(session: any, game: CoverGame, content: string) {
    logger.info(`[调试] 匹配成功: "${content}" -> ${game.songTitle} (用户: ${session.userId})`)
    // 清除定时器
    if (game.timerId) {
      clearTimeout(game.timerId)
      logger.info(`[调试] 清除定时器: ${game.songTitle} (ID: ${game.songId})`)
    }
    const channelId = session.channelId || session.guildId || 'private'
    games.delete(channelId)
    const timeUsed = Math.floor((Date.now() - game.startTime) / 1000)
    
    // 构建消息，仅在群聊中@用户
    // 使用guildId判断是否为群聊（私聊只有channelId，没有guildId）
    const isGroupChat = !!session.guildId
    
    if (isGroupChat) {
      // 群聊：使用at元素
      return [
        `🎉 恭喜 `,
        h('at', { id: session.userId }),
        ` 猜对了！\n`,
        ...buildAnswerMessage('歌曲: ', game.songId, game.songTitle, timeUsed)
      ]
    } else {
      // 私聊：直接显示文本
      return buildAnswerMessage(`🎉 恭喜你猜对了！\n歌曲: `, game.songId, game.songTitle, timeUsed)
    }
  }

  ctx.middleware(async (session, next) => {
    const channelId = session.channelId || session.guildId || 'private'
    const game = games.get(channelId)

    if (!game || !game.active) {
      return next()
    }

    const content = session.content?.trim()
    if (!content) {
      return next()
    }

    const contentLower = content.toLowerCase()
    const songTitleLower = game.songTitle.toLowerCase()

    // 计算字符数量（用于部分匹配）
    const chineseCharCount = (content.match(/[\u4e00-\u9fa5]/g) || []).length
    const englishCharCount = (content.match(/[a-zA-Z]/g) || []).length

    // 检查完整歌名匹配
    if (contentLower === songTitleLower) {
      return handleMatchSuccess(session, game, content)
    }

    // 检查别名匹配
    const aliasInfo = (gameCache.aliasData || []).find(alias => alias.SongID.toString() === game.songId)
    if (aliasInfo) {
      // 完整别名匹配
      if (aliasInfo.Name.toLowerCase() === contentLower ||
          aliasInfo.Alias.some(alias => alias.toLowerCase() === contentLower)) {
        return handleMatchSuccess(session, game, content)
      }

      // 别名部分匹配（6个字母或3个汉字）
      const allAliases = [aliasInfo.Name, ...aliasInfo.Alias]
      const aliasMatch = allAliases.some(alias => {
        const aliasLower = alias.toLowerCase()
        const aliasChineseCount = (alias.match(/[\u4e00-\u9fa5]/g) || []).length
        const aliasEnglishCount = (alias.match(/[a-zA-Z]/g) || []).length
        return (chineseCharCount >= 3 && aliasLower.includes(contentLower) && aliasChineseCount >= 3) ||
               (englishCharCount >= 6 && aliasLower.includes(contentLower) && aliasEnglishCount >= 6)
      })
      if (aliasMatch) {
        return handleMatchSuccess(session, game, content)
      }
    }

    // 检查歌名部分匹配（6个字母或3个汉字）
    if ((chineseCharCount >= 3 && songTitleLower.includes(contentLower)) ||
        (englishCharCount >= 6 && songTitleLower.includes(contentLower))) {
      return handleMatchSuccess(session, game, content)
    }

    return next()
  })
}
