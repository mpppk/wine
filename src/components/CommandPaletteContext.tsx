import {
	createContext,
	type Dispatch,
	type ReactNode,
	type SetStateAction,
	useContext,
	useMemo,
	useState,
} from "react";

type CommandPaletteContextValue = {
	open: boolean;
	setOpen: Dispatch<SetStateAction<boolean>>;
};

const CommandPaletteContext = createContext<CommandPaletteContextValue | null>(
	null,
);

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
	const [open, setOpen] = useState(false);
	const value = useMemo(() => ({ open, setOpen }), [open]);

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
