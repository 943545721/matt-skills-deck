/**
 * 插件版本号的唯一真源。
 *
 * 为什么单独立一份：服务端编译后的产物里拿不到 `import.meta`（Paseo 的打包器会把它置空），
 * 所以不能靠读 package.json 或 `import.meta.url` 反查版本；两端都需要这个值时只能有个常量。
 * 改版本时同时改这里和 package.json，tests/version.test.mjs 会比对两处是否一致。
 */
export const PLUGIN_VERSION = "0.1.0";
