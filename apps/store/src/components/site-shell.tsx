import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  Search,
  Menu,
  ArrowUpRight,
  ArrowUp,
  ArrowRight,
  Sparkle,
} from "lucide-react";
import { Logo } from "@/components/logo";
import { Marquee, MarqueeItem } from "@/components/boldkit/marquee";
import { buttonVariants } from "@/components/boldkit/button";
import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@workspace/ui/components/sheet";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@workspace/ui/components/dialog";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@workspace/ui/components/select";
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
  { value: "bg" as const, label: "Български", code: "BG", flag: "bg" },
  { value: "en" as const, label: "English", code: "EN", flag: "gb" },
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
      <DialogContent closeLabel={m.close()} className="search-dialog">
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
      <p className="sr-only">{m.announcement()}</p>
      <Marquee
        className="announcement border-b-3 border-foreground bg-foreground text-primary"
        speed="slow"
        aria-hidden="true"
      >
        {[m.marquee_1(), m.marquee_2(), m.marquee_3(), m.marquee_4()].map(
          (text) => (
            <MarqueeItem key={text} className="text-sm">
              <Sparkle aria-hidden="true" className="size-3.5 fill-accent text-accent" />
              {text}
            </MarqueeItem>
          ),
        )}
      </Marquee>
      <header className="site-header">
        <div className="header-main">
          <Link to="/" className="wordmark" aria-label="Metal Craft">
            <Logo />
          </Link>
          <nav className="primary-nav" aria-label={m.main_nav()}>
            <Link to="/collection" search={{}}>
              {m.collection()}
            </Link>
            <Link to="/about">{m.about()}</Link>
          </nav>
          <div className="header-right">
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
        <SheetContent closeLabel={m.close()}
          side="right"
          className="mobile-menu"
          id="mobile-navigation"
        >
          <SheetHeader>
            <SheetTitle className="wordmark">
              <Logo />
              <span className="sr-only">Metal Craft</span>
            </SheetTitle>
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
      <footer className="site-footer border-t-3 border-foreground">
        <div className="footer-cta border-b-3 border-foreground bg-primary text-primary-foreground">
          <div className="footer-inner flex flex-col items-start justify-between gap-6 py-12 md:flex-row md:items-center">
            <h2 className="footer-cta-title">{m.cta_heading()}</h2>
            <Link
              to="/collection"
              search={{}}
              className={buttonVariants({ variant: "ink", size: "xl" })}
            >
              {m.view_collection()}
              <ArrowRight />
            </Link>
          </div>
        </div>
        <div className="bg-foreground text-background">
          <div className="footer-inner grid gap-10 py-14 md:grid-cols-[1.2fr_2fr_1fr]">
            <div className="space-y-5">
              <Link to="/" className="wordmark footer-logo" aria-label="Metal Craft">
                <Logo />
              </Link>
              <p className="max-w-[34ch] text-sm text-background/75">
                {m.footer_body()}
              </p>
              <div className="footer-language">
                <LanguageSelector full />
              </div>
            </div>
            <div>
              <h3 className="footer-heading">{m.explore()}</h3>
              <ul className="footer-collections">
                {categoryIds.map((id) => (
                  <li key={id}>
                    <Link to="/collection" search={{ category: id }}>
                      {categoryLabel(id)}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="footer-heading">{m.discover()}</h3>
              <ul className="footer-links">
                <li>
                  <Link to="/collection" search={{}}>
                    {m.view_collection()}
                  </Link>
                </li>
                <li>
                  <Link to="/about">{m.about()}</Link>
                </li>
                <li>
                  <Link to="/about" hash="materials">
                    {m.materials()}
                  </Link>
                </li>
                <li>
                  <Link to="/account">{m.account()}</Link>
                </li>
              </ul>
            </div>
          </div>
          <div className="footer-inner flex flex-col gap-3 border-t-3 border-background/25 py-6 text-xs text-background/70 sm:flex-row sm:items-center sm:justify-between">
            <p>{m.copyright({ year: "2026" })}</p>
            <p>{m.photo_credit()}</p>
            <a
              href="#main-content"
              aria-label={m.skip()}
              className="footer-top"
            >
              <ArrowUp size={18} />
            </a>
          </div>
        </div>
      </footer>
    </>
  );
}
