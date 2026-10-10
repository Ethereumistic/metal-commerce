import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Search, Menu, ArrowUpRight, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { AccountLink, BagButton } from "@/components/cart";
import { m } from "@/paraglide/messages";
import { getLocale, setLocale, type Locale } from "@/paraglide/runtime";
import { categoryLabel } from "@/lib/catalog";
import {
  useCategories,
  type StoreCard,
  type ProductCatalog,
} from "@/lib/commerce";

const languageOptions = [
  { value: "en" as const, label: "English", code: "EN", flag: "gb" },
  { value: "fr" as const, label: "Français", code: "FR", flag: "fr" },
  { value: "de" as const, label: "Deutsch", code: "DE", flag: "de" },
];

export function LanguageSelector({ full = false }: { full?: boolean }) {
  const current = languageOptions.find((item) => item.value === getLocale())!;
  return (
    <Select
      value={getLocale()}
      onValueChange={(value) => {
        if (value) void setLocale(value as Locale);
      }}
    >
      <SelectTrigger
        aria-label={m.language() + ": " + current.label}
        className="language-select"
      >
        <img
          src={"https://flagcdn.com/" + current.flag + ".svg"}
          width="20"
          height="14"
          alt=""
          className="flag"
        />
        <SelectValue>{full ? current.label : current.code}</SelectValue>
      </SelectTrigger>
      <SelectContent
        align="end"
        alignItemWithTrigger={false}
        className="language-options"
      >
        {languageOptions.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            <img
              src={"https://flagcdn.com/" + item.flag + ".svg"}
              width="20"
              height="14"
              alt=""
              className="flag"
            />
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function SearchDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { categories } = useCategories();
  const categoryIds = categories.map((category) => category.id);
  const [query, setQuery] = useState("");
  const term = query.trim();
  const [results, setResults] = useState<StoreCard[]>([]);
  const [state, setState] = useState<
    "loading" | "ready" | "unavailable" | "refine"
  >("ready");
  useEffect(() => {
    setResults([]);
    if (!open || !term) {
      setState("ready");
      return;
    }
    if (term.length > 200 || term.split(/\s+/).length > 16) {
      setState("refine");
      return;
    }
    const controller = new AbortController();
    setState("loading");
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ q: term, limit: "8" });
      void fetch(`/api/products?${params}`, {
        signal: controller.signal,
        cache: "no-store",
      })
        .then(async (response) => {
          const data = (await response.json()) as ProductCatalog;
          if (controller.signal.aborted) return;
          if (!response.ok || data.productStatus !== "ready") {
            setState(
              data.errorCode === "INVALID_REQUEST" ? "refine" : "unavailable",
            );
            return;
          }
          setResults(data.products);
          setState("ready");
        })
        .catch(() => {
          if (!controller.signal.aborted) setState("unavailable");
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, term]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="search-dialog">
        <DialogHeader>
          <DialogTitle>{m.search_title()}</DialogTitle>
          <DialogDescription className="sr-only">
            {m.search_placeholder()}
          </DialogDescription>
        </DialogHeader>
        <div className="search-field">
          <Search size={21} />
          <Input
            aria-label={m.search()}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={m.search_placeholder()}
          />
        </div>
        {term ? (
          <div className="search-results" aria-live="polite">
            <p className="small-label">
              {state === "loading"
                ? m.search_loading()
                : m.search_matches({ count: results.length })}
            </p>
            {results.length ? (
              results.map((piece) => (
                <Link
                  key={piece.slug}
                  to="/pieces/$slug"
                  params={{ slug: piece.slug }}
                  onClick={() => onOpenChange(false)}
                  className="search-result"
                >
                  {piece.images[0] && (
                    <img
                      src={piece.images[0].thumbnail}
                      width={piece.images[0].width}
                      height={piece.images[0].height}
                      alt=""
                      loading="lazy"
                      decoding="async"
                    />
                  )}
                  <span>
                    <strong>{piece.name}</strong>
                    <span>
                      {categoryLabel(piece.category)} / {piece.optionLabel}
                    </span>
                  </span>
                  <ArrowUpRight size={18} />
                </Link>
              ))
            ) : (
              <p className="empty-search">
                {state === "loading"
                  ? m.search_loading()
                  : state === "refine"
                    ? m.search_refine()
                    : state === "ready"
                      ? m.search_none()
                      : m.products_unavailable()}
              </p>
            )}
            {state === "ready" && (
              <Link
                className="text-link"
                to="/collection"
                search={{ q: term }}
                onClick={() => onOpenChange(false)}
              >
                {m.search_view_all()}
                <ArrowUpRight size={18} />
              </Link>
            )}
          </div>
        ) : (
          <div className="search-suggestions">
            <p className="small-label">{m.search_suggestions()}</p>
            {categoryIds.map((id) => (
              <Link
                to="/collection"
                search={{ category: id }}
                key={id}
                onClick={() => onOpenChange(false)}
              >
                {categoryLabel(id)}
                <ArrowUpRight size={18} />
              </Link>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function SiteShell({ children }: { children: ReactNode }) {
  const { categories } = useCategories();
  const categoryIds = categories.map((category) => category.id);
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  return (
    <>
      <a href="#main-content" className="skip-link">
        {m.skip()}
      </a>
      <div className="announcement">{m.announcement()}</div>
      <header className="site-header">
        <div className="header-main">
          <Link to="/" className="wordmark" aria-label="MORIS">
            MORIS
          </Link>
          <nav className="category-nav" aria-label={m.collection()}>
            <Link to="/collection" search={{}} className="all-collection">
              {m.collection()}
            </Link>
            <span className="nav-divider" aria-hidden="true" />
            {categoryIds.map((id) => (
              <Link key={id} to="/collection" search={{ category: id }}>
                {categoryLabel(id)}
              </Link>
            ))}
          </nav>
          <div className="header-right">
            <Link to="/about" className="header-story">
              {m.about()}
            </Link>
            <Button
              variant="ghost"
              className="search-toggle"
              aria-label={m.search()}
              onClick={() => setSearchOpen(true)}
            >
              <Search size={20} />
              <span>{m.search()}</span>
            </Button>
            <LanguageSelector />
            <AccountLink />
            <BagButton />
            <Button
              className="menu-toggle icon-button"
              variant="ghost"
              aria-label={m.menu()}
              aria-expanded={menuOpen}
              aria-controls="mobile-navigation"
              onClick={() => setMenuOpen(true)}
            >
              <Menu size={24} />
            </Button>
          </div>
        </div>
      </header>
      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent
          side="right"
          className="mobile-menu"
          id="mobile-navigation"
        >
          <SheetHeader>
            <SheetTitle className="wordmark">MORIS</SheetTitle>
            <SheetDescription className="sr-only">
              {m.collection()}
            </SheetDescription>
          </SheetHeader>
          <nav aria-label={m.collection()}>
            <Link
              to="/collection"
              search={{}}
              onClick={() => setMenuOpen(false)}
              className="menu-collection"
            >
              {m.all_pieces()}
              <ArrowUpRight size={22} />
            </Link>
            {categoryIds.map((id) => (
              <Link
                key={id}
                to="/collection"
                search={{ category: id }}
                onClick={() => setMenuOpen(false)}
              >
                {categoryLabel(id)}
                <ArrowUpRight size={18} />
              </Link>
            ))}
          </nav>
          <div className="menu-secondary">
            <Link to="/about" onClick={() => setMenuOpen(false)}>
              {m.about()}
            </Link>
            <Link to="/account" onClick={() => setMenuOpen(false)}>
              {m.account()}
            </Link>
            <LanguageSelector full />
          </div>
        </SheetContent>
      </Sheet>
      <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
      <main id="main-content" tabIndex={-1}>
        {children}
      </main>
      <footer className="site-footer">
        <div className="footer-top">
          <div>
            <h2>{m.footer_heading()}</h2>
            <p>{m.footer_body()}</p>
          </div>
          <Link to="/collection" search={{}} className="footer-cta">
            {m.view_collection()}
            <ArrowUpRight size={26} />
          </Link>
        </div>
        <div className="footer-bottom">
          <Link to="/" className="wordmark footer-wordmark" aria-label="MORIS">
            MORIS
          </Link>
          <div className="footer-links">
            <p>{m.explore()}</p>
            {categoryIds.map((id) => (
              <Link key={id} to="/collection" search={{ category: id }}>
                {categoryLabel(id)}
              </Link>
            ))}
          </div>
          <div className="footer-links">
            <p>{m.discover()}</p>
            <Link to="/about">{m.about()}</Link>
            <Link to="/about" hash="materials">
              {m.materials()}
            </Link>
            <div className="footer-language">
              <LanguageSelector full />
            </div>
          </div>
        </div>
        <div className="footer-meta">
          <p>{m.copyright({ year: "2026" })}</p>
          <p>{m.photo_credit()}</p>
          <a href="#main-content" aria-label={m.skip()}>
            <ArrowRight className="-rotate-90" size={20} />
          </a>
        </div>
      </footer>
    </>
  );
}
