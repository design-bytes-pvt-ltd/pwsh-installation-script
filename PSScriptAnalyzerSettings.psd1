@{
    Severity     = @('Error', 'Warning')
    ExcludeRules = @(
        'PSAvoidUsingWriteHost',
        'PSUseShouldProcessForStateChangingFunctions',
        'PSReviewUnusedParameter',
        'PSAvoidUsingEmptyCatchBlock',
        'PSUseSingularNouns',
        'PSShouldProcess'
    )
}
