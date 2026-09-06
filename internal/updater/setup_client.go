package updater

import (
	"context"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"time"

	p "github.com/intellisys-stevens/leviathan/internal/updateprotocol"
)

func (c *Client) SetupRedeem(ctx context.Context, in p.SetupRedeemRequest) (p.SetupRedeemResponse, error) {
	var out p.SetupRedeemResponse
	b, err := json.Marshal(in)
	if err != nil {
		return out, ErrControl
	}
	err = c.jsonRequest(ctx, p.SetupRedeemPath, b, &out)
	clear(b)
	if err == nil && (out.Schema != p.Schema || !jobIDPattern.MatchString(out.SetupID) || !out.Machine.Valid()) {
		err = ErrControl
	}
	return out, err
}
func (c *Client) SetupAuthorize(ctx context.Context, in p.SetupAuthorizeRequest) (p.SetupAuthorizeResponse, error) {
	var out p.SetupAuthorizeResponse
	err := c.signedJSON(ctx, p.SetupAuthorizePath, in, &out)
	if err == nil && (out.Schema != p.Schema || out.SetupID != in.SetupID || !out.Allowed || !out.InstallBefore.After(c.now()) || out.InstallBefore.After(c.now().Add(2*time.Minute))) {
		err = ErrControl
	}
	return out, err
}
func (c *Client) SetupArtifact(ctx context.Context, in p.SetupArtifactRequest) (io.ReadCloser, error) {
	b, err := c.signedBody(p.SetupArtifactPath, in)
	if err != nil {
		return nil, err
	}
	response, err := c.request(ctx, p.SetupArtifactPath, b)
	if err != nil {
		return nil, err
	}
	kind, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || response.StatusCode != http.StatusOK || kind != "application/gzip" || response.ContentLength > p.MaxArchiveBytes {
		response.Body.Close()
		return nil, ErrControl
	}
	return response.Body, nil
}
func (c *Client) SetupReport(ctx context.Context, in p.SetupReportRequest) error {
	var out p.ReportResponse
	if err := c.signedJSON(ctx, p.SetupReportPath, in, &out); err != nil {
		return err
	}
	if out.Schema != p.Schema || !out.Accepted {
		return ErrControl
	}
	return nil
}
func (c *Client) SetupStatus(ctx context.Context, in p.SetupStatusRequest) (p.SetupStatusResponse, error) {
	var out p.SetupStatusResponse
	err := c.signedJSON(ctx, p.SetupStatusPath, in, &out)
	if err == nil && (out.Schema != p.Schema || out.Setup.ID != in.SetupID || out.Setup.Machine != c.config.Machine) {
		err = ErrControl
	}
	return out, err
}
