/**
 * 三个「面」的 id。
 *
 * 客户端注册面时按 `^[a-z][a-z0-9-]*$` 校验 id：小写字母开头，只允许小写字母、数字、连字符。
 * **点号在这里不合法**——跟 RPC 方法名不是一套规则（那个允许 `deck.issues.list`），照 RPC 的
 * 习惯写成 `deck.board` 会让整个插件加载失败，界面上只留一行 `Invalid workspace panel id`。
 *
 * 单独放在这个文件里，是为了让测试能直接钉住这条规则（`tests/ids.test.mjs`）。
 */
export const DECK_PANEL_ID = "deck-board";
export const DECK_SCREEN_ID = "deck-home";
export const DECK_SIDEBAR_ID = "deck";
export const DECK_SETTINGS_ID = "deck-settings";

/** 全部会交给客户端校验的 id，测试逐条比对规则。 */
export const DECK_CONTRIBUTION_IDS = [DECK_PANEL_ID, DECK_SCREEN_ID, DECK_SIDEBAR_ID, DECK_SETTINGS_ID] as const;
