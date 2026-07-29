import {
	type ComponentType,
	createContext,
	type Dispatch,
	type ReactNode,
	type SetStateAction,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";

/**
 * 表示中のページが差し込むコマンド。地図ページの「AIに質問」のように実行へ画面固有の
 * 文脈(地域・選択中AOP・ダイアログの開閉state)が要るものは、常駐するパレット側からは
 * 組み立てられない。ページが登録し、パレットは登録順に描画する。
 */
export type PaletteCommand = {
	/** 登録の同一性キー(パレットの key) */
	id: string;
	label: string;
	/** ラベル以外でも引っかけたい検索語 */
	keywords?: string[];
	icon?: ComponentType<{ className?: string }>;
	run: () => void | Promise<void>;
};

type CommandPaletteContextValue = {
	open: boolean;
	setOpen: Dispatch<SetStateAction<boolean>>;
	/** 表示中のページが登録したコマンド(登録順) */
	pageCommands: PaletteCommand[];
	/** コマンドを登録し、登録解除する関数を返す */
	registerCommand: (command: PaletteCommand) => () => void;
};

const CommandPaletteContext = createContext<CommandPaletteContextValue | null>(
	null,
);

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
	const [open, setOpen] = useState(false);
	const [pageCommands, setPageCommands] = useState<PaletteCommand[]>([]);

	// 解除は id ではなく登録したオブジェクトの同一性で行う。同じ id の再登録と
	// 旧登録の解除が前後しても、生きている登録を巻き添えで消さないため。
	const registerCommand = useCallback((command: PaletteCommand) => {
		setPageCommands((prev) => [...prev, command]);
		return () => setPageCommands((prev) => prev.filter((c) => c !== command));
	}, []);

	const value = useMemo(
		() => ({ open, setOpen, pageCommands, registerCommand }),
		[open, pageCommands, registerCommand],
	);

	return (
		<CommandPaletteContext.Provider value={value}>
			{children}
		</CommandPaletteContext.Provider>
	);
}

export function useCommandPalette() {
	const ctx = useContext(CommandPaletteContext);
	if (!ctx) {
		throw new Error(
			"useCommandPalette must be used within a CommandPaletteProvider",
		);
	}
	return ctx;
}

/**
 * ページ固有コマンドを、そのページが表示されている間だけパレットに載せる。
 * `command` に null を渡すと登録しない(条件付きで出し分けるページ向け)。
 */
export function usePaletteCommand(command: PaletteCommand | null) {
	const { registerCommand } = useCommandPalette();

	// run は毎レンダー新しいクロージャになる(画面の state を捕まえるため)。参照を
	// 依存に入れると登録・解除が毎レンダー走ってパレットの並びが揺れるので、登録
	// するのは ref を読む薄いラッパにして、実体だけを差し替える。登録し直すのは
	// 表示に効く値(id・ラベル・アイコン・検索語の内容)が変わったときだけ。
	const runRef = useRef(command?.run);
	useEffect(() => {
		runRef.current = command?.run;
	});

	const id = command?.id;
	const label = command?.label;
	const icon = command?.icon;
	const keywordsKey = command?.keywords?.join(" ");

	useEffect(() => {
		if (id === undefined || label === undefined) return;
		return registerCommand({
			id,
			label,
			icon,
			// cmdk は keywords を1本の検索文字列に連結して照合するので、依存判定用の
			// キーから配列へ戻すときに語の区切りが変わっても引っかかり方は変わらない。
			keywords: keywordsKey ? keywordsKey.split(" ") : undefined,
			run: () => runRef.current?.(),
		});
	}, [registerCommand, id, label, icon, keywordsKey]);
}
