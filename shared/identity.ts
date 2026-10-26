/**
 * 插件身份的唯一真源。
 *
 * 服务端要靠它在 daemon 的 config.json 里找到自己的安装目录（见 server/paths.ts），
 * 写错一个字符就会在运行时才炸，所以 tests 里比对它与 manifest 的 id 是否一致。
 */
export const PLUGIN_ID = "matt-skills-deck";
