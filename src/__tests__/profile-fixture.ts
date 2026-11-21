const CERTIFICATE_DER =
  "MIIB3TCCAYOgAwIBAgIUW5xKmwyuAsOOgDd6Nd5ww4OkO+MwCgYIKoZIzj0EAwIwRDEwMC4GA1UEAwwnVGVzdCBEaXN0cmlidXRpb246IEV4YW1wbGUgKFRFQU0wMDAwMDApMRAwDgYDVQQKDAdFeGFtcGxlMB4XDTI2MTEyMTE2MTUwN1oXDTM2MTExODE2MTUwN1owRDEwMC4GA1UEAwwnVGVzdCBEaXN0cmlidXRpb246IEV4YW1wbGUgKFRFQU0wMDAwMDApMRAwDgYDVQQKDAdFeGFtcGxlMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEOx4oyl+qnp5wfg17/MnDgYARkGcuX5oq3FJq/8D+PRW8MwSNknhBiOF9bCsIMU+uDdTOGwfLDuC0hSdcRo+zJ6NTMFEwHQYDVR0OBBYEFJ1p+72q6G0AWZYL1nBPtwMsVW5OMB8GA1UdIwQYMBaAFJ1p+72q6G0AWZYL1nBPtwMsVW5OMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIgRYk3nUCF7iuir10udaX0F6NTYJucwFwzRjALDZgnKgICIQDzM+bpg/EbXc7faRAi/vjsZ738duJ/QiqBCXCjmXDNnQ==";

export const FIXTURE_CERTIFICATE_SERIAL = "5B9C4A9B0CAE02C38E80377A35DE70C383A43BE3";

interface ProfileOptions {
  devices?: string[];
  taskAllow?: boolean;
  allDevices?: boolean;
  icloud?: boolean;
  certificates?: string[];
}

export function profileXml(options: ProfileOptions = {}) {
  const { devices, taskAllow = false, allDevices = false, icloud = true } = options;
  const certificates = options.certificates ?? [CERTIFICATE_DER];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>AppIDName</key>
	<string>Acme &amp; Co App</string>
	<key>ApplicationIdentifierPrefix</key>
	<array>
		<string>TEAM000000</string>
	</array>
	<key>CreationDate</key>
	<date>2026-01-01T00:00:00Z</date>
	<key>Platform</key>
	<array>
		<string>iOS</string>
	</array>
	<key>DeveloperCertificates</key>
	<array>
${certificates.map((c) => `		<data>${c}</data>`).join("\n")}
	</array>
	<key>Entitlements</key>
	<dict>
		<key>application-identifier</key>
		<string>TEAM000000.com.acme.app</string>
		<key>aps-environment</key>
		<string>production</string>
${
  icloud
    ? `		<key>com.apple.developer.icloud-container-identifiers</key>
		<array>
			<string>iCloud.com.acme.app</string>
		</array>
		<key>com.apple.developer.icloud-services</key>
		<array>
			<string>CloudKit</string>
		</array>
`
    : ""
}		<key>get-task-allow</key>
		${taskAllow ? "<true/>" : "<false/>"}
		<key>keychain-access-groups</key>
		<array/>
	</dict>
	<key>ExpirationDate</key>
	<date>2027-01-01T00:00:00Z</date>
	<key>Name</key>
	<string>Acme App Store</string>
${
  devices
    ? `	<key>ProvisionedDevices</key>
	<array>
${devices.map((d) => `		<string>${d}</string>`).join("\n")}
	</array>
`
    : ""
}${allDevices ? "	<key>ProvisionsAllDevices</key>\n	<true/>\n" : ""}	<key>TeamIdentifier</key>
	<array>
		<string>TEAM000000</string>
	</array>
	<key>TeamName</key>
	<string>Example Team</string>
	<key>TimeToLive</key>
	<integer>365</integer>
	<key>UUID</key>
	<string>00000000-0000-0000-0000-000000000001</string>
	<key>Version</key>
	<integer>1</integer>
</dict>
</plist>`;
}

export function wrapCms(xml: string) {
  return Buffer.concat([
    Buffer.from([0x30, 0x82, 0x0a, 0x00, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01]),
    Buffer.from(xml, "utf-8"),
    Buffer.from([0xa0, 0x82, 0x01, 0x00, 0x30, 0x82, 0x00, 0x10]),
  ]);
}

export function buildProfile(options: ProfileOptions = {}) {
  return wrapCms(profileXml(options)).toString("base64");
}
