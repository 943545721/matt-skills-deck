import { Modal } from "@getpaseo/plugin/client/ui";
import { useMemo, useState } from "react";
import { Image, Pressable, Text, useWindowDimensions, View } from "react-native";
import type { DeckLang, RequirementMode } from "../../../shared/requirement.ts";
import { entryCopy } from "./entryCopy.ts";
import { ENTRY_CARD_H, ENTRY_CARD_W, entryCardDataUri, entryCardSvg, type EntryCardCopy } from "./entryCardSvg.ts";

/**
 * 「探讨需求」的选路浮层：标题 + 两张整卡可点的流程示意图（两张卡 = 两种谈法）。
 *
 * DSH 原版是挂在 document.body 的绝对定位浮层（kernel/entry-choice.ts），
 * Paseo 没有 DOM 定位层，这里退到宿主 Modal——结构不变：两张卡竖排、
 * 探索地图在上、实施地图在下，点整张卡立即选路，不替人判断走哪条。
 * 卡面本身是 entryCardSvg 的逐字移植，不用通用图标重新猜一张。
 *
 * 宿主原生端（iOS / Android）的 RN Image 不解 SVG：onError 后降级成同一份
 * brow / state / body 的文字卡，保证选路动作在所有端都可用；桌面 / web 仍是原图。
 */
const CARDS: { mode: RequirementMode }[] = [
  { mode: "explore" },
  { mode: "implement" },
];

const FALLBACK_BG = "#10131a";
const FALLBACK_LINE = "#2a2d35";
const FALLBACK_MUTE = "#a1a1aa";

function EntryCard({
  mode,
  copy,
  uri,
  width,
  height,
  onPick,
}: {
  mode: RequirementMode;
  copy: EntryCardCopy;
  uri: string;
  width: number;
  height: number;
  onPick(mode: RequirementMode): void;
}) {
  const [failed, setFailed] = useState(false);
  const accent = mode === "explore" ? "#c084fc" : "#93c5fd";

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={copy.brow}
      onPress={() => onPick(mode)}
      style={({ pressed }) => ({ borderRadius: 12, overflow: "hidden", opacity: pressed ? 0.85 : 1 })}
    >
      {failed ? (
        <View
          style={{
            width,
            height,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: FALLBACK_LINE,
            backgroundColor: FALLBACK_BG,
            padding: 16,
            justifyContent: "center",
            gap: 8,
          }}
        >
          <Text style={{ color: accent, fontSize: 12, letterSpacing: 1.2, opacity: 0.72 }}>{copy.brow}</Text>
          <Text style={{ color: accent, fontSize: 17, fontWeight: "700" }}>{copy.state}</Text>
          <Text style={{ color: FALLBACK_MUTE, fontSize: 12, lineHeight: 17 }}>{copy.body}</Text>
        </View>
      ) : (
        <Image
          source={{ uri }}
          style={{ width, height, alignSelf: "center" }}
          resizeMode="contain"
          onError={() => setFailed(true)}
          accessibilityIgnoresInvertColors
        />
      )}
    </Pressable>
  );
}

export function RequirementChooser({
  lang,
  open,
  onOpenChange,
  onPick,
}: {
  lang: DeckLang;
  open: boolean;
  onOpenChange(open: boolean): void;
  onPick(mode: RequirementMode): void;
}) {
  const copy = entryCopy(lang);
  // DSH 的 chooser 是紧凑浮层；填满其可用内容宽度，避免卡片缩在宿主宽弹窗中央。
  const { width: windowWidth } = useWindowDimensions();
  const modalWidth = Math.min(416, Math.max(280, windowWidth - 32));
  const cardWidth = Math.min(ENTRY_CARD_W, modalWidth - 24);
  const cardHeight = Math.round((cardWidth * ENTRY_CARD_H) / ENTRY_CARD_W);
  const cards = useMemo(
    () =>
      CARDS.map(({ mode }) => {
        const cardCopy = mode === "explore" ? copy.explore : copy.impl;
        return {
          mode,
          copy: cardCopy,
          uri: entryCardDataUri(entryCardSvg(mode, cardCopy, lang)),
        };
      }),
    [copy, lang],
  );

  return (
    <Modal title={copy.chooserTitle} open={open} onOpenChange={onOpenChange}>
      <Modal.Content
        contentContainerStyle={{
          width: modalWidth,
          maxWidth: modalWidth,
          alignSelf: "center",
          alignItems: "center",
          gap: 7,
          paddingHorizontal: 12,
          paddingVertical: 8,
        }}
      >
        <View style={{ width: cardWidth, gap: 7 }}>
          {cards.map((card) => (
            <EntryCard
              key={card.mode}
              mode={card.mode}
              copy={card.copy}
              uri={card.uri}
              width={cardWidth}
              height={cardHeight}
              onPick={onPick}
            />
          ))}
        </View>
      </Modal.Content>
    </Modal>
  );
}
