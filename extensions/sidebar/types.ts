import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type Theme = ExtensionContext["ui"]["theme"];

export type GitState = {
	insideRepo: boolean;
	branch?: string;
	files: Array<{ code: string; path: string; delta?: string }>;
	insertions: number;
	deletions: number;
	changedFiles: number;
	error?: string;
};

export type SidebarState = {
	enabled: boolean;
	collapsed: boolean;
	gitDetail: boolean;
	fullHeight: boolean;
	git: GitState;
	lastGitRefresh?: number;
	turnCount: number;
	isStreaming: boolean;
	lastTool?: string;
};

export type SidebarRenderOptions = {
	maxFiles: number;
	buffer: number;
	fillRows: number;
	verticalPadding: number;
	getThinkingLevel: () => string | undefined;
};

export type SidebarSectionContext = {
	ctx: ExtensionContext | undefined;
	state: SidebarState;
	theme: Theme;
	innerWidth: number;
	add: (line?: string) => void;
	heading: (label: string) => void;
	muted: (s: string) => string;
	dim: (s: string) => string;
	options: SidebarRenderOptions;
};
