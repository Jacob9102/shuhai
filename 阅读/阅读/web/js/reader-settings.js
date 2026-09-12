/**
 * reader-settings.js —— 阅读设置面板（阅读器抽屉 + 全局设置页共用同一份实现）
 * 所有改动直接写入 store，页面通过 CSS 变量实时生效，切换零闪烁。
 */

import { h, icon, clamp } from './ui.js';
import { getSettings, updateSettings, getPresets, resetSettings, subscribe } from './store.js';

/* ------------------------------------------------------------------ *
 * 简繁转换：内置常用字映射表（简 ↔ 繁），开启后对正文显示做字符级转换
 * ------------------------------------------------------------------ */
const CHAR_PAIRS = [
  '们們','个個','为為','这這','来來','说說','时時','会會','后後','学學','国國','对對','开開','关關','门門',
  '问問','间間','闻聞','长長','车車','东東','马馬','鸟鳥','鱼魚','龙龍','风風','飞飛','见見','贝貝','页頁',
  '头頭','买買','卖賣','读讀','书書','语語','话話','记記','认認','让讓','请請','谢謝','谁誰','谈談','论論',
  '议議','试試','该該','诸諸','课課','调調','变變','边邊','达達','过過','还還','进進','远遠','运運','连連',
  '迟遲','选選','递遞','适適','遗遺','邮郵','乡鄉','农農','军軍','写寫','决決','况況','净淨','凉涼','减減',
  '击擊','则則','刚剛','创創','剂劑','剑劍','剧劇','劝勸','办辦','务務','动動','劳勞','势勢','医醫','华華',
  '协協','单單','卫衛','厂廠','历歷','厉厲','压壓','厌厭','厕廁','厅廳','厦廈','县縣','参參','双雙','发發',
  '叠疊','号號','叹嘆','吓嚇','吗嗎','听聽','启啟','员員','呜嗚','咏詠','响響','哑啞','唤喚','啰囉','啧嘖',
  '啸嘯','喷噴','嘱囑','团團','园園','围圍','图圖','圆圓','圣聖','场場','坏壞','块塊','坚堅','坛壇','坝壩',
  '坟墳','坠墜','垄壟','垒壘','垦墾','堕墮','墙牆','壮壯','声聲','壳殼','处處','备備','复復','够夠','夺奪',
  '奖獎','奋奮','妆妝','妇婦','妈媽','娱娛','婴嬰','孙孫','宁寧','宝寶','实實','宠寵','审審','宫宮','宽寬',
  '宾賓','寝寢','寻尋','导導','寿壽','将將','尔爾','尘塵','尝嘗','尧堯','层層','尸屍','尽盡','届屆','属屬',
  '岁歲','岂豈','岗崗','岛島','岭嶺','峡峽','崭嶄','巅巔','巩鞏','币幣','帅帥','师師','帐帳','帘簾','带帶',
  '帮幫','广廣','庄莊','庆慶','庐廬','库庫','应應','废廢','异異','弃棄','张張','弥彌','弯彎','弹彈','强強',
  '归歸','当當','录錄','彻徹','径徑','忆憶','忧憂','怀懷','态態','怜憐','总總','恋戀','恳懇','恶惡','恼惱',
  '悦悅','悬懸','惊驚','惧懼','惨慘','惩懲','惭慚','惯慣','愿願','慑懾','懒懶','戏戲','战戰','户戶','扑撲',
  '执執','扩擴','扫掃','扬揚','扰擾','抚撫','抛拋','抢搶','护護','报報','担擔','拟擬','拥擁','择擇','挂掛',
  '挚摯','挡擋','挤擠','挥揮','捞撈','损損','换換','据據','掳擄','掺摻','揽攬','摊攤','撑撐','撵攆','擞擻',
  '攒攢','敌敵','敛斂','数數','断斷','无無','旧舊','旷曠','昙曇','显顯','晓曉','暂暫','术術','机機','杀殺',
  '杂雜','权權','条條','杨楊','极極','构構','枢樞','枪槍','标標','栋棟','栏欄','树樹','样樣','档檔','桥橋',
  '梦夢','检檢','椭橢','楼樓','槛檻','横橫','橱櫥','欢歡','欧歐','残殘','殴毆','毁毀','毕畢','毙斃','气氣',
  '汇匯','汉漢','汤湯','沟溝','没沒','沦淪','沪滬','泪淚','泻瀉','泼潑','泽澤','洁潔','洒灑','测測','济濟',
  '浏瀏','浑渾','浓濃','涛濤','涝澇','润潤','涧澗','涨漲','涩澀','渊淵','渐漸','渔漁','渗滲','温溫','滞滯',
  '满滿','滤濾','滥濫','滨濱','滩灘','潜潛','澜瀾','灭滅','灯燈','灵靈','灾災','灿燦','炉爐','点點','炼煉',
  '烂爛','烛燭','烦煩','烧燒','焕煥','爷爺','爱愛','牵牽','牺犧','犹猶','狈狽','狮獅','独獨','狭狹','狱獄',
  '猎獵','猪豬','猫貓','献獻','玛瑪','环環','现現','玺璽','珑瓏','琐瑣','瑶瑤','电電','画畫','畅暢','疗療',
  '疟瘧','疮瘡','疯瘋','痒癢','痪瘓','痴癡','瘫癱','皱皺','盗盜','盘盤','监監','盖蓋','睁睜','瞒瞞','矫矯',
  '矿礦','码碼','砖磚','础礎','硕碩','确確','碍礙','碱鹼','礼禮','祸禍','祷禱','离離','种種','积積','称稱',
  '秽穢','稳穩','穷窮','窃竊','窜竄','窝窩','窥窺','竖豎','竞競','笋筍','笔筆','笼籠','筑築','筛篩','签簽',
  '简簡','篮籃','类類','粮糧','紧緊','练練','组組','细細','织織','终終','绊絆','经經','给給','络絡','绝絕',
  '统統','继繼','绩績','绪緒','续續','绳繩','维維','绵綿','综綜','绿綠','缀綴','缘緣','编編','缓緩','缔締',
  '缕縷','缚縛','缝縫','缠纏','缩縮','缴繳','网網','罗羅','罚罰','罢罷','羁羈','翘翹','耻恥','聂聶','职職',
  '联聯','聪聰','肃肅','肠腸','肤膚','肿腫','胀脹','胁脅','胆膽','胜勝','胶膠','脉脈','脏臟','脑腦','脓膿',
  '脸臉','腊臘','腾騰','舰艦','舱艙','艰艱','艳艷','艺藝','节節','芦蘆','苏蘇','苹蘋','茎莖','荐薦','荡蕩',
  '荣榮','药藥','莱萊','莲蓮','获獲','莹瑩','萧蕭','萨薩','葱蔥','蓝藍','蓟薊','蔷薔','蔼藹','蕴蘊','虏虜',
  '虑慮','虚虛','虫蟲','虽雖','蚀蝕','蚁蟻','蚕蠶','蛮蠻','蜡蠟','蝇蠅','蝉蟬','衅釁','衔銜','补補','衬襯',
  '袄襖','装裝','裤褲','观觀','规規','视視','览覽','觉覺','触觸','订訂','计計','讯訊','讨討','训訓','讲講',
  '讳諱','讶訝','讷訥','许許','讼訟','讽諷','设設','访訪','诀訣','证證','评評','识識','诉訴','诊診','词詞',
  '译譯','诗詩','诘詰','诚誠','诞誕','询詢','详詳','诫誡','诬誣','误誤','诵誦','诺諾','谅諒','谊誼','谋謀',
  '谎謊','谐諧','谓謂','谚諺','谜謎','谣謠','谦謙','谨謹','谱譜','谷穀','丰豐','贞貞','负負','贡貢','财財',
  '责責','贤賢','败敗','账賬','货貨','质質','贩販','贪貪','贫貧','购購','贯貫','贱賤','贴貼','贵貴','贷貸',
  '贸貿','费費','贺賀','贼賊','贾賈','贿賄','资資','赋賦','赌賭','赏賞','赐賜','赔賠','赖賴','赚賺','赛賽',
  '赞讚','赠贈','赢贏','赵趙','赶趕','趋趨','跃躍','践踐','踪蹤','轨軌','转轉','轮輪','软軟','轰轟','轴軸',
  '轻輕','载載','较較','辅輔','辆輛','辈輩','辉輝','辐輻','输輸','辖轄','辗輾','辙轍','辞辭','辩辯','辫辮',
  '辽遼','迁遷','迈邁','违違','逊遜','逻邏','邓鄧','郑鄭','邻鄰','郁鬱','酝醞','酱醬','酿釀','释釋','里裡',
  '鉴鑒','针針','钉釘','钓釣','钙鈣','钝鈍','钟鐘','钢鋼','钥鑰','钱錢','钳鉗','钻鑽','铁鐵','铃鈴','铅鉛',
  '银銀','铺鋪','链鏈','销銷','锁鎖','锅鍋','锋鋒','锐銳','错錯','锡錫','锣鑼','锤錘','锦錦','键鍵','锯鋸',
  '镖鏢','镜鏡','闪閃','闭閉','闯闖','闰閏','闲閒','闷悶','闸閘','闹鬧','阀閥','阁閣','阅閱','队隊','阳陽',
  '阴陰','阵陣','阶階','际際','陆陸','陈陳','险險','隐隱','随隨','难難','雏雛','雾霧','韦韋','韧韌','韩韓',
  '顶頂','顷頃','项項','顺順','须須','顽頑','顾顧','顿頓','预預','领領','颊頰','频頻','颓頹','颗顆','题題',
  '颜顏','额額','颠顛','颤顫','飘飄','饥飢','饭飯','饮飲','饰飾','饱飽','饲飼','饶饒','饺餃','饼餅','馆館',
  '馈饋','馒饅','驭馭','驰馳','驱驅','驳駁','驴驢','驶駛','驼駝','驾駕','骂罵','骄驕','骆駱','验驗','骑騎',
  '骗騙','骚騷','骤驟','髅髏','斗鬥','鲁魯','鲜鮮','鸡雞','鸣鳴','鸦鴉','鸭鴨','鸯鴦','鸳鴛','鸽鴿','鹅鵝',
  '鹰鷹','麦麥','黄黃','齐齊','齿齒','龄齡','龟龜','邓鄧','谚諺','挂掛','周週','划劃','尸屍','启啟','布佈',
  '干幹','才纔','与與','丑醜','云雲','伙夥','体體','余餘','佛彿','佣傭','侄姪','杰傑','松鬆','板闆','梁樑',
  '楼樓','欲慾','毁燬','氛雰','注註','涂塗','游遊','湿濕','灶灶','烟煙','猫貓','发髮','尽儘','咸鹹','咽嚥',
  '唇脣','启啓','尝嚐','弥瀰','扑撲','抵牴','捏揑','捆捆','采採','钟鍾','面麵','饥饑','馆舘','鸟鳥',
];

const MAP_T2S = new Map();
const MAP_S2T = new Map();
(function buildMaps() {
  for (const pair of CHAR_PAIRS) {
    if (typeof pair !== 'string' || pair.length < 2) continue;
    const s = pair.charAt(0);
    const t = pair.charAt(1);
    if (!s || !t || s === t) continue;
    if (!MAP_T2S.has(t)) MAP_T2S.set(t, s);
    if (!MAP_S2T.has(s)) MAP_S2T.set(s, t);
  }
})();

/**
 * 字符级简繁转换
 * @param {string} text
 * @param {boolean} toTraditional true 转繁体，false 转简体
 */
export function convertText(text, toTraditional) {
  if (!text) return text || '';
  const map = toTraditional ? MAP_S2T : MAP_T2S;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    out += map.get(ch) || ch;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 面板构建
 * ------------------------------------------------------------------ */

/** 内置字体选项 */
const FONT_OPTIONS = [
  { label: '系统默认', value: '' },
  { label: '宋体', value: '"Songti SC", SimSun, "Noto Serif CJK SC", serif' },
  { label: '黑体', value: '"Heiti SC", SimHei, "Microsoft YaHei", sans-serif' },
  { label: '楷体', value: '"Kaiti SC", KaiTi, STKaiti, serif' },
  { label: '仿宋', value: 'FangSong, "FangSong_GB2312", STFangsong, serif' },
  { label: '思源宋体', value: '"Source Han Serif SC", "Noto Serif CJK SC", serif' },
  { label: '思源黑体', value: '"Source Han Sans SC", "Noto Sans CJK SC", sans-serif' },
  { label: '苹方', value: '"PingFang SC", "Hiragino Sans GB", sans-serif' },
  { label: '微软雅黑', value: '"Microsoft YaHei", "PingFang SC", sans-serif' },
  { label: '系统无衬线', value: 'system-ui, -apple-system, "Segoe UI", sans-serif' },
  { label: '等宽字体', value: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
];

/** 翻页模式选项 */
const MODE_OPTIONS = [
  { value: 'scroll', label: '上下滚动', icon: 'sort' },
  { value: 'slide', label: '左右滑动', icon: 'forward' },
  { value: 'cover', label: '仿真覆盖', icon: 'layers' },
  { value: 'none', label: '无动画', icon: 'minus' },
  { value: 'vertical', label: '上下翻页', icon: 'down' },
];

/**
 * 渲染设置面板
 * @param {HTMLElement} container 容器
 * @param {object} opts { onChange(patch, settings), compact }
 * @returns {Function} 销毁函数
 */
export function renderReaderSettings(container, opts = {}) {
  const onChange = opts.onChange || function () {};
  const refreshers = [];
  let applying = false;

  /** 统一的设置入口 */
  const set = (patch) => {
    applying = true;
    const next = updateSettings(patch, { source: 'panel' });
    applying = false;
    onChange(patch, next);
  };

  /** 注册一个需要在外部设置变化时同步的控件 */
  const register = (fn) => { refreshers.push(fn); };

  /* ---------- 分组骨架 ---------- */
  const groupTheme = h('div', { class: 'set-group' }, h('h4', {}, icon('palette', 15), h('span', { text: '背景与主题' })));
  const groupFont = h('div', { class: 'set-group' }, h('h4', {}, icon('textSize', 15), h('span', { text: '字体' })));
  const groupLayout = h('div', { class: 'set-group' }, h('h4', {}, icon('layout', 15), h('span', { text: '排版与自适应' })));
  const groupPage = h('div', { class: 'set-group' }, h('h4', {}, icon('layers', 15), h('span', { text: '翻页' })));
  const groupOther = h('div', { class: 'set-group' }, h('h4', {}, icon('gear', 15), h('span', { text: '其他' })));

  /* ---------- 主题预设 ---------- */
  const themeCards = h('div', { class: 'theme-cards' });
  function renderThemeCards() {
    themeCards.textContent = '';
    const presets = getPresets();
    const cur = getSettings().theme;
    for (const preset of presets) {
      const patch = preset.patch || {};
      const preview = h('div', {
        class: 'theme-preview',
        style: {
          background: patch.bgColor || '#fff',
          color: patch.textColor || '#333',
        },
        text: '文',
      });
      const card = h('button', {
        class: 'theme-card' + (cur === preset.id ? ' active' : ''),
        type: 'button',
        on: { click: () => set(Object.assign({}, patch, { bgImage: '' })) },
      }, preview, h('div', { class: 'theme-name', text: preset.name || preset.id }));
      card.dataset.themeId = preset.id;
      themeCards.appendChild(card);
    }
    // 自定义主题卡片
    const custom = h('button', {
      class: 'theme-card' + (cur === 'custom' ? ' active' : ''),
      type: 'button',
      on: { click: () => set({ theme: 'custom' }) },
    }, h('div', { class: 'theme-preview', style: { background: 'linear-gradient(135deg,#fff 50%,#1f1f1f 50%)', color: '#888' }, text: '自' }),
      h('div', { class: 'theme-name', text: '自定义' }));
    themeCards.appendChild(custom);
  }
  renderThemeCards();
  register(renderThemeCards);
  groupTheme.appendChild(themeCards);

  /* ---------- 颜色 ---------- */
  groupTheme.appendChild(colorRow('背景颜色', 'bgColor', register, set));
  groupTheme.appendChild(colorRow('文字颜色', 'textColor', register, set));

  // 背景图
  const bgImageInput = h('input', {
    class: 'input input-sm', type: 'text', placeholder: '图片地址，留空则关闭',
    value: getSettings().bgImage,
    on: { change: () => set({ bgImage: bgImageInput.value.trim() }) },
  });
  register(() => { bgImageInput.value = getSettings().bgImage; });
  groupTheme.appendChild(h('div', { class: 'set-row' },
    h('span', { class: 'setting-label', text: '背景图' }), bgImageInput));

  groupTheme.appendChild(sliderRow('背景图透明度', 'bgOpacity', 0, 100, 1, (v) => v + '%', register, set));
  groupTheme.appendChild(sliderRow('亮度', 'brightness', 20, 100, 1, (v) => v + '%', register, set));

  /* ---------- 字体 ---------- */
  const fontSelect = h('select', { class: 'select input-sm', on: { change: () => set({ fontFamily: fontSelect.value }) } });
  for (const opt of FONT_OPTIONS) fontSelect.appendChild(h('option', { value: opt.value, text: opt.label }));
  register(() => {
    const cur = getSettings().fontFamily;
    const match = FONT_OPTIONS.some((o) => o.value === cur);
    fontSelect.value = match ? cur : '';
    if (!match) fontSelect.selectedIndex = 0;
  });
  groupFont.appendChild(h('div', { class: 'set-row' }, h('span', { class: 'setting-label', text: '字体' }), fontSelect));

  const fontCustom = h('input', {
    class: 'input input-sm', type: 'text', placeholder: '自定义 font-family，如 "LXGW WenKai", serif',
    on: { change: () => set({ fontFamily: fontCustom.value.trim() }) },
  });
  register(() => { fontCustom.value = getSettings().fontFamily; });
  groupFont.appendChild(h('div', { class: 'set-row' }, h('span', { class: 'setting-label', text: '自定义' }), fontCustom));

  // 字号：A- / 滑块 / A+ / 数值
  const sizeLabel = h('span', { class: 'setting-value' });
  const sizeRange = h('input', {
    type: 'range', min: '12', max: '40', step: '1',
    on: { input: () => set({ fontSize: Number(sizeRange.value) }) },
  });
  const sizeMinus = h('button', { class: 'btn btn-sm', type: 'button', on: { click: () => stepFont(-1) } }, icon('minus', 14));
  const sizePlus = h('button', { class: 'btn btn-sm', type: 'button', on: { click: () => stepFont(1) } }, icon('plus', 14));
  register(() => {
    const v = getSettings().fontSize;
    sizeRange.value = String(v);
    sizeLabel.textContent = v + ' px';
  });
  groupFont.appendChild(h('div', { class: 'setting-item' },
    h('div', { class: 'setting-label' }, h('span', { text: '字号' }), sizeLabel),
    h('div', { class: 'setting-row' }, sizeMinus, sizeRange, sizePlus)
  ));

  const weightSelect = h('select', { class: 'select input-sm', on: { change: () => set({ fontWeight: Number(weightSelect.value) }) } });
  [300, 400, 500, 600, 700].forEach((w) => weightSelect.appendChild(h('option', { value: String(w), text: w + (w === 400 ? '（常规）' : w === 700 ? '（粗体）' : '') })));
  register(() => { weightSelect.value = String(getSettings().fontWeight); });
  groupFont.appendChild(h('div', { class: 'set-row' }, h('span', { class: 'setting-label', text: '字重' }), weightSelect));

  groupFont.appendChild(sliderRow('行高', 'lineHeight', 1.2, 3.0, 0.05, (v) => Number(v).toFixed(2), register, set));
  groupFont.appendChild(sliderRow('字间距', 'letterSpacing', 0, 5, 0.5, (v) => v + ' px', register, set));

  /* ---------- 排版 ---------- */
  groupLayout.appendChild(sliderRow('段间距', 'paragraphSpacing', 0, 3, 0.1, (v) => Number(v).toFixed(1) + ' em', register, set));
  groupLayout.appendChild(sliderRow('首行缩进', 'textIndent', 0, 4, 0.5, (v) => v + ' em', register, set));

  // 对齐方式
  const alignSeg = segmented([
    { value: 'left', label: '左对齐' },
    { value: 'justify', label: '两端对齐' },
  ], 'textAlign', register, set);
  groupLayout.appendChild(h('div', { class: 'set-row' }, h('span', { class: 'setting-label', text: '对齐' }), alignSeg));

  // 列宽模式
  const layoutSeg = segmented([
    { value: 'auto', label: '自适应' },
    { value: 'fixed', label: '固定宽度' },
  ], 'layoutMode', register, set);
  groupLayout.appendChild(h('div', { class: 'set-row' }, h('span', { class: 'setting-label', text: '列宽' }), layoutSeg));
  groupLayout.appendChild(sliderRow('最大列宽', 'pageWidth', 320, 1600, 20, (v) => v + ' px', register, set));
  groupLayout.appendChild(sliderRow('左右边距', 'pagePadding', 0, 80, 2, (v) => v + ' px', register, set));
  groupLayout.appendChild(switchRow('字号随视口缩放', 'fontScaleWithWidth', register, set));

  /* ---------- 翻页 ---------- */
  const modeGrid = h('div', { class: 'mode-grid' });
  function renderModeGrid() {
    modeGrid.textContent = '';
    const cur = getSettings().pageMode;
    for (const m of MODE_OPTIONS) {
      modeGrid.appendChild(h('button', {
        class: 'mode-card' + (cur === m.value ? ' active' : ''),
        type: 'button',
        on: { click: () => set({ pageMode: m.value }) },
      }, icon(m.icon, 18), h('span', { text: m.label })));
    }
  }
  renderModeGrid();
  register(renderModeGrid);
  groupPage.appendChild(modeGrid);
  groupPage.appendChild(sliderRow('动画时长', 'animateDuration', 0, 600, 20, (v) => v + ' ms', register, set));

  const clickSeg = segmented([
    { value: 'none', label: '关闭' },
    { value: 'left-right', label: '左中右' },
    { value: 'all', label: '上下半屏' },
  ], 'clickArea', register, set);
  groupPage.appendChild(h('div', { class: 'set-row' }, h('span', { class: 'setting-label', text: '点击翻页' }), clickSeg));

  /* ---------- 其他 ---------- */
  const autoReadSwitch = switchNode(getSettings().autoRead.enabled, (val) => set({ autoRead: Object.assign({}, getSettings().autoRead, { enabled: val }) }));
  register(() => { autoReadSwitch.input.checked = getSettings().autoRead.enabled; });
  groupOther.appendChild(h('div', { class: 'set-row' },
    h('span', { class: 'setting-label', text: '自动阅读' }), h('span', { class: 'spacer' }), autoReadSwitch.el));
  groupOther.appendChild(sliderRow('自动阅读速度', 'autoReadSpeed', 10, 400, 5, (v) => v + ' px/s', register, (patch) => {
    set({ autoRead: Object.assign({}, getSettings().autoRead, { speed: patch.autoReadSpeed, enabled: true }) });
  }, 'autoRead.speed'));

  groupOther.appendChild(switchRow('阅读时保持屏幕常亮', 'keepScreenOn', register, set));
  groupOther.appendChild(switchRow('显示底部进度条', 'showProgress', register, set));
  groupOther.appendChild(switchRow('显示时间', 'showClock', register, set));
  groupOther.appendChild(switchRow('显示电量', 'showBattery', register, set));
  groupOther.appendChild(switchRow('全屏阅读', 'fullscreen', register, set));
  groupOther.appendChild(switchRow('简繁转换（繁 → 简）', 'simplify', register, set));
  groupOther.appendChild(switchRow('启用 [ ] 字号快捷键', 'fontSizeShortcut', register, set));
  groupOther.appendChild(switchRow('隐藏状态栏（沉浸）', 'hideStatusBar', register, set));

  // 恢复默认
  const resetBtn = h('button', {
    class: 'btn btn-ghost btn-block', type: 'button',
    on: {
      click: () => {
        resetSettings();
        onChange({}, getSettings());
      },
    },
  }, icon('refresh', 16), h('span', { text: '恢复默认阅读设置' }));
  groupOther.appendChild(resetBtn);

  container.appendChild(groupTheme);
  container.appendChild(groupFont);
  container.appendChild(groupLayout);
  container.appendChild(groupPage);
  container.appendChild(groupOther);

  // 字号快捷键
  function stepFont(delta) {
    const cur = getSettings().fontSize;
    set({ fontSize: clamp(cur + delta, 12, 40) });
  }

  // 外部（全局设置页 / 阅读器）改动时同步控件
  const unsubscribe = subscribe(() => {
    if (applying) return;
    renderThemeCards();
    renderModeGrid();
    refreshers.forEach((fn) => fn());
  });
  refreshers.forEach((fn) => fn());

  return function dispose() {
    unsubscribe();
    container.textContent = '';
  };
}

/* ------------------------------------------------------------------ *
 * 控件工厂
 * ------------------------------------------------------------------ */

/** 颜色行：取色器 + 十六进制输入 */
function colorRow(label, key, register, set) {
  const picker = h('input', { type: 'color', value: toHex(getSettings()[key]), on: { input: () => hexInput.value = picker.value, change: () => set({ [key]: picker.value, theme: 'custom' }) } });
  const hexInput = h('input', {
    class: 'input input-sm', type: 'text', value: getSettings()[key], style: { maxWidth: '110px' },
    on: {
      change: () => {
        const v = normalizeHex(hexInput.value);
        if (v) { picker.value = v; set({ [key]: v, theme: 'custom' }); }
        else hexInput.value = getSettings()[key];
      },
    },
  });
  register(() => {
    const v = getSettings()[key];
    picker.value = toHex(v);
    hexInput.value = v;
  });
  return h('div', { class: 'set-row' }, h('span', { class: 'setting-label', text: label }), picker, hexInput);
}

/** 滑块行 */
function sliderRow(label, key, min, max, step, format, register, set, path) {
  const valueEl = h('span', { class: 'setting-value' });
  const range = h('input', {
    type: 'range', min: String(min), max: String(max), step: String(step),
    on: {
      input: () => {
        const v = Number(range.value);
        valueEl.textContent = format(v);
        if (path === 'autoRead.speed') set({ autoReadSpeed: v });
        else set({ [key]: v });
      },
    },
  });
  const read = () => (path === 'autoRead.speed' ? getSettings().autoRead.speed : getSettings()[key]);
  register(() => {
    const v = read();
    range.value = String(v);
    valueEl.textContent = format(v);
  });
  return h('div', { class: 'setting-item' },
    h('div', { class: 'setting-label' }, h('span', { text: label }), valueEl),
    range
  );
}

/** 开关行 */
function switchRow(label, key, register, set) {
  const sw = switchNode(getSettings()[key], (val) => set({ [key]: val }));
  register(() => { sw.input.checked = !!getSettings()[key]; });
  return h('div', { class: 'set-row' }, h('span', { class: 'setting-label', text: label }), h('span', { class: 'spacer' }), sw.el);
}

/** 开关控件 */
function switchNode(checked, onChange) {
  const input = h('input', { type: 'checkbox', checked: !!checked, on: { change: () => onChange(input.checked) } });
  const el = h('label', { class: 'switch' }, input, h('span', { class: 'track' }));
  return { el, input };
}

/** 分段控件 */
function segmented(options, key, register, set) {
  const wrap = h('div', { class: 'segmented' });
  const buttons = [];
  for (const opt of options) {
    const btn = h('button', {
      class: 'active', type: 'button', text: opt.label,
      on: { click: () => set({ [key]: opt.value }) },
    });
    btn.dataset.value = opt.value;
    buttons.push(btn);
    wrap.appendChild(btn);
  }
  register(() => {
    const cur = getSettings()[key];
    buttons.forEach((b) => b.classList.toggle('active', b.dataset.value === cur));
  });
  return wrap;
}

/** 颜色值兜底 */
function toHex(color) {
  const v = String(color || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v;
  if (/^#[0-9a-fA-F]{3}$/.test(v)) {
    return '#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
  }
  return '#ffffff';
}

/** 校验十六进制颜色 */
function normalizeHex(input) {
  const v = String(input || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(v)) return ('#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3]).toLowerCase();
  if (/^[0-9a-fA-F]{6}$/.test(v)) return '#' + v.toLowerCase();
  return null;
}

export default renderReaderSettings;
