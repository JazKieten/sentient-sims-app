import { Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material';
import { IpcRendererEvent } from 'electron';
import { CaughtError } from 'main/sentient-sims/models/CaughtError';
import { useEffect, useMemo, useState } from 'react';
import { knownPlainError } from 'main/sentient-sims/util/providerErrorWords';
import { SendLogModal } from './components/SendLogModal';

type CaughtErrorState = {
  open: boolean;
  caughtError?: CaughtError;
};

export function CaughtErrorPopupNotificationModal() {
  const [state, setState] = useState<CaughtErrorState>({
    open: false,
  });
  const [sendLogModalOpen, setSendLogModalOpen] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    const removeListener = window.electron.onCaughtErrorPopupNotification(
      (_event: IpcRendererEvent, caughtError: CaughtError) => {
        setState((prevState) => {
          const isSameError = prevState.caughtError?.message === caughtError.message;

          if (isSameError) {
            return prevState;
          }

          return {
            open: true,
            caughtError,
          };
        });
      },
    );

    return () => {
      removeListener();
    };
  }, []);

  const onClose = () => {
    setShowDetails(false);
    setState({
      open: false,
      caughtError: state.caughtError,
    });
  };

  // The raw text stays one click away for support; the player reads what to do
  const plainMessage = useMemo(() => {
    const raw = state.caughtError?.message;
    if (!raw) {
      return null;
    }
    return (
      knownPlainError(raw) ??
      'Sentient Sims hit a problem it did not expect. If it keeps happening, press Send Logs so the team can take a look.'
    );
  }, [state.caughtError]);

  return (
    <>
      <Dialog open={state.open} onClose={onClose} aria-labelledby="exception-dialog-title" maxWidth="sm" fullWidth>
        <DialogTitle id="exception-dialog-title">Something went wrong</DialogTitle>
        <DialogContent dividers>
          {plainMessage && <Typography>{plainMessage}</Typography>}
          {showDetails && state.caughtError?.message && (
            <Typography variant="body2" sx={{ marginTop: 2, color: 'text.secondary', wordBreak: 'break-word' }}>
              {state.caughtError.message}
            </Typography>
          )}
        </DialogContent>
        <DialogActions>
          {state.caughtError?.message && !showDetails && (
            <Button
              onClick={() => {
                setShowDetails(true);
              }}
              sx={{ marginRight: 'auto' }}
            >
              Details
            </Button>
          )}
          <Button onClick={onClose}>Close</Button>
          <Button
            onClick={() => {
              setSendLogModalOpen(true);
              onClose();
            }}
            variant="contained"
            color="primary"
          >
            Send Logs
          </Button>
        </DialogActions>
      </Dialog>
      <SendLogModal open={sendLogModalOpen} setOpen={setSendLogModalOpen} caughtError={state.caughtError} />
    </>
  );
}
