import { useState } from "react";

/** 「高级」区新增 env 键的草稿；保存成功后由调用方清空。 */
export function useEnvAddition() {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  return { key, value, changeKey: setKey, changeValue: setValue };
}

export type EnvAddition = ReturnType<typeof useEnvAddition>;
