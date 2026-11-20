/**
 * The app's own words, in the service's language: NetEase Cloud Music is a Chinese service, and its app on a
 * phone is in Chinese whatever the phone's language is, so this one is too (the task's own labels: 推荐 / 歌单 /
 * 电台·榜单 / 我的, 搜索). The app's name for a screen reader is the cabin's word for it (`text.apps.spotify`,
 * which every language file already has as this site's name).
 *
 * A word that is a sentence with a number in it is a function; everything else is a string.
 */
export interface Words {
  tabs: Record<'recommend' | 'playlists' | 'channels' | 'mine', string>
  search: string
  searchHint: string
  searchFor: (query: string) => string
  cancel: string
  back: string
  close: string
  play: string
  pause: string
  next: string
  previous: string
  shuffle: string
  repeat: string
  volume: string
  mute: string
  unmute: string
  nowPlaying: string
  lyrics: string
  queue: string
  playingFrom: string
  upNext: string
  /** What a list holds. */
  songs: (count: number) => string
  minutes: (count: number) => string
  hours: (count: number) => string
  /** Home's shelves. */
  dailySongs: string
  dailyHint: string
  recommendedPlaylists: string
  recommendedHint: string
  showAll: string
  refresh: string
  /** The search's groups. */
  groups: Record<'songs' | 'playlists' | 'artists' | 'albums', string>
  recent: string
  clearRecent: string
  noResults: string
  noResultsHint: string
  /** A page that didn't load, and the layer not running at all. */
  failed: string
  tryAgain: string
  layerDown: string
  layerDownHint: string
  empty: string
  /** What things are. */
  kinds: Record<'playlist' | 'album' | 'artist' | 'song' | 'chart', string>
  /** The charts tab. */
  charts: string
  chartsHint: string
  chart: string
  /** 我的: the account, and the QR sign-in. */
  mine: string
  /** The account's own playlists, the ones it collected, and 我喜欢的音乐. */
  myPlaylists: string
  collectedPlaylists: string
  loved: string
  noMinePlaylists: string
  signedOut: string
  signedOutHint: string
  signIn: string
  signOut: string
  vip: string
  member: string
  scanTitle: string
  scanHint: string
  scanWith: string
  signInStates: Record<'waiting' | 'scanned' | 'confirmed' | 'expired' | 'asking' | 'failed', string>
  scanAgain: string
  done: string
  /** 收藏: the heart on the song playing. */
  like: string
  unlike: string
  likeSignedOut: string
  /** A song the service won't give here. */
  noRight: string
  noRightFor: (name: string) => string
  /** The words. */
  noLyrics: string
  lyricsFailed: string
  lyricsPlain: string
  /** A song's own row. */
  playAll: string
  trackNumber: string
}

export const WORDS: Words = {
  tabs: { recommend: '推荐', playlists: '歌单', channels: '电台·榜单', mine: '我的' },
  search: '搜索',
  searchHint: '搜索歌曲、歌手、歌单',
  searchFor: (query) => `搜索“${query}”`,
  cancel: '取消',
  back: '返回',
  close: '关闭',
  play: '播放',
  pause: '暂停',
  next: '下一首',
  previous: '上一首',
  shuffle: '随机播放',
  repeat: '循环播放',
  volume: '音量',
  mute: '静音',
  unmute: '取消静音',
  nowPlaying: '正在播放',
  lyrics: '歌词',
  queue: '播放列表',
  playingFrom: '播放来源',
  upNext: '接下来播放',
  songs: (count) => `${count} 首`,
  minutes: (count) => (count > 0 ? `${count} 分钟` : '不到 1 分钟'),
  hours: (count) => `${count} 小时`,
  dailySongs: '每日推荐',
  dailyHint: '根据你的口味，每天 6:00 更新',
  recommendedPlaylists: '推荐歌单',
  recommendedHint: '为你挑选',
  showAll: '查看全部',
  refresh: '换一批',
  groups: { songs: '单曲', playlists: '歌单', artists: '歌手', albums: '专辑' },
  recent: '最近播放',
  clearRecent: '清空',
  noResults: '没有找到相关的歌曲',
  noResultsHint: '换一个词试试',
  failed: '加载失败',
  tryAgain: '重试',
  layerDown: '网易云音乐未启动',
  layerDownHint: '请在电脑上重新启动 WestPlay，或检查网络连接',
  empty: '这里还什么都没有',
  kinds: { playlist: '歌单', album: '专辑', artist: '歌手', song: '单曲', chart: '榜单' },
  charts: '榜单',
  chartsHint: '网易云音乐的全部榜单',
  chart: '榜单',
  mine: '我的',
  myPlaylists: '我的歌单',
  collectedPlaylists: '收藏的歌单',
  loved: '我喜欢的音乐',
  noMinePlaylists: '还没有歌单，去网易云音乐里创建或收藏一些吧',
  signedOut: '未登录',
  signedOutHint: '登录后同步你的歌单和每日推荐',
  signIn: '扫码登录',
  signOut: '退出登录',
  vip: '黑胶VIP',
  member: '网易云音乐用户',
  scanTitle: '扫码登录',
  scanHint: '打开网易云音乐手机客户端，扫一扫',
  scanWith: '扫码',
  signInStates: {
    waiting: '等待扫码',
    scanned: '已扫码，请在手机上确认',
    confirmed: '登录成功',
    expired: '二维码已过期',
    asking: '正在获取二维码',
    failed: '二维码获取失败',
  },
  scanAgain: '刷新二维码',
  done: '完成',
  like: '收藏到「我喜欢的音乐」',
  unlike: '取消收藏',
  likeSignedOut: '登录后才能收藏',
  noRight: '无版权，无法播放',
  noRightFor: (name) => `《${name}》无版权，无法播放`,
  noLyrics: '暂无歌词',
  lyricsFailed: '歌词加载失败',
  lyricsPlain: '歌词',
  playAll: '播放全部',
  trackNumber: '序号',
}
