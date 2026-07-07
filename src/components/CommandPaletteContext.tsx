import {
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
 * A command that can be shown in the command palette. Pages register their
 * context-specific commands via {@link useCommandPaletteCommands}; global
 * commands (navigation, theme, auth) are defined inside `CommandPalette`.
 */
export type PaletteCommand = {
	/** Stable, unique identifier — also used as the cmdk item value. */
	id: string;
	label: string;
	/** Extra search terms (e.g. Japanese synonyms) for cmdk filtering. */
	keywords?: string[];
	icon?: ReactNode;
	onSelect: () => void;
};

type CommandPaletteContextValue = {
	open: boolean;
	setOpen: Dispatch<SetStateAction<boolean>>;
	/** Context commands registered by the currently mounted pages. */
	commands: PaletteCommand[];
	/** Registers commands and returns a cleanup that unregisters them. */
	registerCommands: (commands: PaletteCommand[]) => () => void;
};

const CommandPaletteContext = createContext<CommandPaletteContextValue | null>(
	null,
);

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
	const [open, setOpen] = useState(false);
	const [registrations, setRegistrations] = useState<
		{ id: number; commands: PaletteCommand[] }[]
	>([]);
	const nextIdRef = useRef(0);

	const registerCommands = useCallback((commands: PaletteCommand[]) => {
		const id = nextIdRef.current++;
		setRegistrations((prev) => [...prev, { id, commands }]);
		return () => {
			setRegistrations((prev) => prev.filter((r) => r.id !== id));
		};
	}, []);

	const commands = useMemo(
		() => registrations.flatMap((r) => r.commands),
		[registrations],
	);

	const value = useMemo(
		() => ({ open, setOpen, commands, registerCommands }),
		[open, commands, registerCommands],
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
 * Registers page-specific commands while the calling component is mounted.
 * The `commands` array is rebuilt on every render, so pass a `deps` list that
 * captures everything the commands close over (mirrors useEffect deps).
 */
export function useCommandPaletteCommands(
	commands: PaletteCommand[],
	deps: React.DependencyList,
) {
	const { registerCommands } = useCommandPalette();
	// biome-ignore lint/correctness/useExhaustiveDependencies: caller-provided deps intentionally drive re-registration in place of the freshly-built commands array.
	useEffect(() => registerCommands(commands), [registerCommands, ...deps]);
}
