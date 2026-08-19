/** Wire types for the Game module (TASK game-manager, Phase 2). */

export type GameLayerKind = "BACKGROUND" | "PERSON";
export type GameAssetSource = "UPLOAD" | "GENERATED";
export type GameSegment = "LIVE" | "SLOT";
export type GamePackStatus = "PARSING" | "READY" | "FAILED";

export interface GameTemplateSpec {
  person: {
    centerX: number;
    centerY: number;
    outerRadius: number;
    innerRadius: number;
    fitCircle: "outer" | "inner";
  };
}

export interface GameTemplate {
  id: string;
  key: string;
  name: string;
  canvasW: number;
  canvasH: number;
  spec: GameTemplateSpec;
}

export interface GamePack {
  id: string;
  filename: string;
  status: GamePackStatus;
  error: string | null;
  assetCount: number;
  totalCount: number;
  createdAt: string;
}

export interface GameAsset {
  id: string;
  kind: GameLayerKind;
  source: GameAssetSource;
  segment: GameSegment | null;
  name: string;
  url: string;
  width: number;
  height: number;
}

export interface GameComposition {
  id: string;
  url: string | null;
  status: "DONE" | "FAILED";
  createdAt: string;
}

export interface GameState {
  template: GameTemplate;
  pack: GamePack | null;
  assets: GameAsset[];
  results: GameComposition[];
}
