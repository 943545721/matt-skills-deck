import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { authCancelRpc, authStartRpc, authStatusRpc, authTokenRpc } from "../../shared/auth.ts";
import { githubAuth } from "../auth.ts";

type StatusInput = RpcInput<typeof authStatusRpc>;
type TokenInput = RpcInput<typeof authTokenRpc>;

export async function authStatusHandler(input: StatusInput): Promise<RpcOutput<typeof authStatusRpc>> {
  return githubAuth.status(input.refresh === true);
}

export async function authStartHandler(): Promise<RpcOutput<typeof authStartRpc>> {
  return githubAuth.start();
}

export async function authCancelHandler(): Promise<RpcOutput<typeof authCancelRpc>> {
  return githubAuth.cancel();
}

export async function authTokenHandler(input: TokenInput): Promise<RpcOutput<typeof authTokenRpc>> {
  // token 只在这个函数里过一次，不写日志、不存设置。
  return githubAuth.loginWithToken(input.token);
}
