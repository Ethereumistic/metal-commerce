import { useMemo } from "react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Field } from "@/components/auth-flow";
import type { Address } from "@/lib/shop";
import { getLocale } from "@/paraglide/runtime";
import { m } from "@/paraglide/messages";

// Delivery markets: EEA, Switzerland, the UK and the US.
const COUNTRIES = [
  "AT", "BE", "BG", "CH", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR",
  "GB", "GR", "HR", "HU", "IE", "IS", "IT", "LI", "LT", "LU", "LV", "MC",
  "MT", "NL", "NO", "PL", "PT", "RO", "SE", "SI", "SK", "US",
];

export function useCountries() {
  const locale = getLocale();
  return useMemo(() => {
    const names = new Intl.DisplayNames([locale], { type: "region" });
    return COUNTRIES.map((code) => ({ code, name: names.of(code) ?? code })).sort(
      (a, b) => a.name.localeCompare(b.name, locale),
    );
  }, [locale]);
}

export function formatAddress(address: Address, countryName: (code: string) => string) {
  return [
    address.name,
    address.line1,
    address.line2,
    [address.postcode, address.city].filter(Boolean).join(" "),
    address.region,
    countryName(address.country),
    address.phone,
  ].filter(Boolean);
}

/**
 * Controlled address fields. `withContact` adds recipient name and phone; the
 * account email is used for addresses, so no email field here.
 */
export function AddressFields({
  value,
  onChange,
  disabled,
  withContact = true,
  idPrefix,
}: {
  value: Address;
  onChange: (next: Address) => void;
  disabled?: boolean;
  withContact?: boolean;
  idPrefix: string;
}) {
  const countries = useCountries();
  const set = (key: keyof Address) => (event: { target: { value: string } }) =>
    onChange({ ...value, [key]: event.target.value });
  return (
    <div className="address-grid">
      {withContact && (
        <>
          <Field label={m.profile_name()} className="address-wide">
            {(id) => (
              <Input id={id} name={`${idPrefix}-name`} autoComplete={`section-${idPrefix} name`} required maxLength={150}
                value={value.name} disabled={disabled} onChange={set("name")} className="moris-input" />
            )}
          </Field>
          <Field label={m.profile_phone()} hint={m.profile_phone_hint()} className="address-wide">
            {(id) => (
              <Input id={id} name={`${idPrefix}-phone`} type="tel" autoComplete={`section-${idPrefix} tel`} maxLength={40}
                pattern="[+()0-9 .\-]{5,40}" value={value.phone} disabled={disabled} onChange={set("phone")} className="moris-input" />
            )}
          </Field>
        </>
      )}
      <Field label={m.address_line1()} className="address-wide">
        {(id) => (
          <Input id={id} name={`${idPrefix}-line1`} autoComplete={`section-${idPrefix} address-line1`} required maxLength={150}
            value={value.line1} disabled={disabled} onChange={set("line1")} className="moris-input" />
        )}
      </Field>
      <Field label={m.address_line2()} className="address-wide">
        {(id) => (
          <Input id={id} name={`${idPrefix}-line2`} autoComplete={`section-${idPrefix} address-line2`} maxLength={150}
            value={value.line2} disabled={disabled} onChange={set("line2")} className="moris-input" />
        )}
      </Field>
      <Field label={m.address_postcode()}>
        {(id) => (
          <Input id={id} name={`${idPrefix}-postcode`} autoComplete={`section-${idPrefix} postal-code`} required maxLength={20}
            value={value.postcode} disabled={disabled} onChange={set("postcode")} className="moris-input" />
        )}
      </Field>
      <Field label={m.address_city()}>
        {(id) => (
          <Input id={id} name={`${idPrefix}-city`} autoComplete={`section-${idPrefix} address-level2`} required maxLength={150}
            value={value.city} disabled={disabled} onChange={set("city")} className="moris-input" />
        )}
      </Field>
      <Field label={m.address_region()}>
        {(id) => (
          <Input id={id} name={`${idPrefix}-region`} autoComplete={`section-${idPrefix} address-level1`} maxLength={150}
            value={value.region ?? ""} disabled={disabled} onChange={set("region")} className="moris-input" />
        )}
      </Field>
      <Field label={m.address_country()}>
        {(id) => (
          <Select
            name={`${idPrefix}-country`}
            required
            disabled={disabled}
            value={value.country || null}
            onValueChange={(country) => onChange({ ...value, country: String(country ?? "") })}
          >
            <SelectTrigger id={id} className="moris-select" aria-label={m.address_country()}>
              <SelectValue placeholder={m.address_country_placeholder()}>
                {(code: string | null) =>
                  code ? countries.find((c) => c.code === code)?.name ?? code : m.address_country_placeholder()
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent className="moris-select-content">
              {countries.map((country) => (
                <SelectItem key={country.code} value={country.code}>
                  {country.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </Field>
    </div>
  );
}

export function addressComplete(address: Address, withContact = true) {
  return (
    (!withContact || !!address.name.trim()) &&
    !!address.line1.trim() &&
    !!address.city.trim() &&
    !!address.postcode.trim() &&
    /^[A-Z]{2}$/.test(address.country)
  );
}
